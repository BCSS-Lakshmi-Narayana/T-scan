"""
data_quality.py — what the corpus actually contains, before anyone asks it a question.

A retrieval system fails silently. When enrichment breaks, a filtered question
returns zero rows, and zero rows read exactly like "there is nothing to find".
The officer concludes the world is quiet. This module exists so that failure
mode is visible and measurable instead.

It answers, per tenant, per collection:

    how many records are there
    how many carry the fields retrieval filters on
    how many have vectors, and do those vectors carry facets
    how fresh is the index
    how many duplicates and orphans are there

Read-only by default. ``--persist`` writes a snapshot into the tenant's own
``ai_data_quality`` collection; nothing is ever written to another tenant's
database, and no source document is modified by this module at all.

Usage
    python data_quality.py --tenant <tenant_id>
    python data_quality.py --all-tenants --json reports/dq.json
    python data_quality.py --tenant <id> --persist

Thresholds come from the architecture document (§P.4) and live in THRESHOLDS
below rather than in the checks, so they can be tuned without touching logic.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from pymongo import MongoClient

# Loaded before `tenants` is imported: that module reads MONGODB_URI at import
# time, so a later load_dotenv() leaves it with no connection string.
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

import tenants  # noqa: E402  (see above)

logger = logging.getLogger("data_quality")

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
VECTOR_COLLECTION = os.getenv("VECTOR_COLLECTION", "vector_embeddings")
SNAPSHOT_COLLECTION = "ai_data_quality"

# coverage ratio -> status. (warning_below, critical_below)
THRESHOLDS: Dict[str, tuple] = {
    "tenant_id":     (1.00, 1.00),   # anything less than total is a boundary defect
    "text":          (0.99, 0.95),
    "published_at":  (0.98, 0.90),
    "url":           (0.95, 0.80),
    "handle":        (0.90, 0.70),
    "districts":     (0.80, 0.50),
    "sentiment":     (0.90, 0.70),
    "risk":          (0.90, 0.70),
    "analysis_done": (0.95, 0.80),
    "embedded":      (0.95, 0.80),
    "districts_inherited": (0.98, 0.90),
}
FRESHNESS_WARN_H = 12
FRESHNESS_CRIT_H = 48


# --------------------------------------------------------------------------- #
# what each collection calls things
#
# Field names diverge across modules (a grievance's author lives in
# posted_by.handle, an alert's in author_handle). The audit asks a logical
# question -- "does this record have an author?" -- so the mapping lives here
# and the checks stay collection-agnostic.
# --------------------------------------------------------------------------- #

@dataclass
class CollectionSpec:
    name: str
    id_field: str                                   # for duplicate detection
    fields: Dict[str, List[str]] = field(default_factory=dict)
    vectorised: bool = True
    # (link_field, parent_collection) when the collection has no districts of
    # its own and inherits them, as alerts do. Auditing it for a field it was
    # never designed to carry reports a defect that does not exist.
    inherited_districts: Optional[tuple] = None
    # Fields the schema fills with a default, so presence proves nothing about
    # whether anything analysed the record: 1,558 of 1,558 contents "have" a
    # sentiment because the default is "neutral", and 505 were never analysed.
    default_valued: List[str] = field(default_factory=list)
    # Records with no parent legitimately have no districts. Counting them as
    # missing coverage turns a design into an alarm.
    districts_require: Optional[str] = None


SPECS: List[CollectionSpec] = [
    CollectionSpec("contents", "content_id", {
        "tenant_id":     ["tenant_id"],
        "text":          ["text", "scraped_content"],
        "published_at":  ["published_at"],
        "url":           ["content_url"],
        "handle":        ["author_handle", "author"],
        "districts":     ["districts"],
        "sentiment":     ["sentiment"],
        "risk":          ["risk_level", "risk_score"],
        "platform":      ["platform"],
    }, default_valued=["sentiment", "risk"], districts_require="source_id"),
    CollectionSpec("alerts", "id", {
        "tenant_id":     ["tenant_id"],
        "text":          ["description", "title"],
        "published_at":  ["content_published_at", "created_at"],
        "url":           ["content_url"],
        "handle":        ["author_handle", "author"],
        "risk":          ["risk_level"],
        "platform":      ["platform"],
        "source_id":     ["source_id"],
    }, inherited_districts=("source_id", "sources")),
    CollectionSpec("grievances", "id", {
        "tenant_id":     ["tenant_id"],
        "text":          ["content.text"],
        "published_at":  ["post_date", "detected_date"],
        "url":           ["tweet_url"],
        "handle":        ["posted_by.handle"],
        "districts":     ["districts"],
        "platform":      ["platform"],
    }),
    # An analysis copies its districts from the content it analysed, so the
    # meaningful check is whether that content can still be resolved -- not how
    # many analyses carry a non-empty list, which only mirrors how many of the
    # analysed posts came from a district-tagged source.
    CollectionSpec("analyses", "id", {
        "tenant_id":     ["tenant_id"],
        "sentiment":     ["sentiment"],
        "risk":          ["risk_level", "risk_score"],
    }, vectorised=False, inherited_districts=("content_id", "contents")),
]

# Facets retrieval filters on. Absent from a chunk means that chunk is
# unreachable by any question naming that facet.
CHUNK_FACETS = [
    "tenant_id", "districts", "kind", "handle", "platform", "url",
    "published_at", "sentiment", "risk_level", "topics", "targets",
    "content_hash", "embed_model",
]

# "not present" for coverage purposes. A field that exists but is null, empty
# string or empty list is not coverage -- it is the appearance of coverage.
_EMPTY = [None, "", []]


def _present(paths: List[str]) -> dict:
    return {"$or": [{p: {"$exists": True, "$nin": _EMPTY}} for p in paths]}


def _status(ratio: float, key: str) -> str:
    warn, crit = THRESHOLDS.get(key, (0.9, 0.7))
    if ratio < crit:
        return "critical"
    if ratio < warn:
        return "warning"
    return "ok"


def _ratio(n: int, total: int) -> float:
    return round(n / total, 4) if total else 0.0


# --------------------------------------------------------------------------- #
# checks
# --------------------------------------------------------------------------- #

def audit_source(db, spec: CollectionSpec, tenant_id: str) -> dict:
    """Field coverage, duplicates and analysis state for one source collection."""
    col = db[spec.name]
    scope = {"tenant_id": tenant_id}
    total = col.count_documents(scope)

    out: Dict[str, Any] = {
        "collection": spec.name, "total": total,
        "coverage": {}, "counts": {}, "status": "ok", "issues": [],
    }
    if not total:
        out["status"] = "empty"
        return out

    for logical, paths in spec.fields.items():
        n = col.count_documents({**scope, **_present(paths)})
        ratio = _ratio(n, total)

        # A field with a schema default is always "present". Say so, and do not
        # let it vote on the collection status.
        if logical in spec.default_valued:
            out["coverage"][logical] = {
                "present": n, "missing": total - n, "ratio": ratio,
                "status": "informational",
                "note": "schema default - presence is not provenance"}
            continue

        # Districts only apply to records that have a parent to inherit from.
        denominator = total
        if logical == "districts" and spec.districts_require:
            denominator = col.count_documents(
                {**scope, **_present([spec.districts_require])})
            n = col.count_documents({**scope, **_present([spec.districts_require]),
                                     **_present(paths)})
            ratio = _ratio(n, denominator)

        st = _status(ratio, logical)
        entry = {"present": n, "missing": denominator - n, "ratio": ratio, "status": st}
        if denominator != total:
            entry["of"] = denominator
            entry["note"] = (f"measured against the {denominator} record(s) with "
                             f"{spec.districts_require}; the rest have no parent")
        out["coverage"][logical] = entry
        if st != "ok":
            out["issues"].append(
                f"{spec.name}.{logical}: {ratio:.0%} coverage "
                f"({denominator - n} missing)")

    # Documents the analyser can never claim. analysis_status is absent or null
    # on these, which is different from "failed" -- a failure retries, this does
    # not, so they stay invisible forever without a repair job.
    if spec.name == "contents":
        stranded = col.count_documents(
            {**scope, "$or": [{"analysis_status": None},
                              {"analysis_status": {"$exists": False}}]})
        done = col.count_documents({**scope, "analysis_status": "done"})
        out["counts"]["analysis_done"] = done
        out["counts"]["analysis_stranded"] = stranded
        ratio = _ratio(done, total)
        out["coverage"]["analysis_done"] = {
            "present": done, "missing": total - done, "ratio": ratio,
            "status": _status(ratio, "analysis_done")}
        if stranded:
            out["issues"].append(
                f"{spec.name}: {stranded} document(s) with no analysis_status "
                f"(unclaimable by the analyser)")

    # Districts by inheritance: the question is not "is the field set" (there
    # is no field) but "can the parent still be resolved".
    if spec.inherited_districts:
        link_field, parent = spec.inherited_districts
        linked = col.count_documents({**scope, **_present([link_field])})
        parents = {d.get("id"): d.get("districts") or []
                   for d in db[parent].find(scope, {"id": 1, "districts": 1})}
        resolvable = with_districts = 0
        for d in col.find({**scope, **_present([link_field])}, {link_field: 1, "_id": 0}):
            got = parents.get(d.get(link_field))
            if got is None:
                continue
            resolvable += 1
            if got:
                with_districts += 1
        ratio = _ratio(resolvable, linked)
        out["counts"]["districts_inherited_from"] = f"{link_field} -> {parent}"
        out["counts"]["parent_resolvable"] = resolvable
        out["counts"]["parent_has_districts"] = with_districts
        out["coverage"]["districts_inherited"] = {
            "present": resolvable, "missing": linked - resolvable, "ratio": ratio,
            "status": _status(ratio, "districts_inherited"),
            "note": f"no districts field by design; scoped via {link_field} -> {parent}"}
        if resolvable < linked:
            out["issues"].append(
                f"{spec.name}: {linked - resolvable} record(s) whose {link_field} "
                f"no longer resolves to a {parent} row - unscopeable")

    # Duplicates by the collection own business id, not by _id.
    try:
        dupes = list(col.aggregate([
            {"$match": scope},
            {"$group": {"_id": f"${spec.id_field}", "n": {"$sum": 1}}},
            {"$match": {"n": {"$gt": 1}}},
            {"$sort": {"n": -1}}, {"$limit": 20},
        ]))
        out["counts"]["duplicate_ids"] = len(dupes)
        if dupes:
            out["issues"].append(
                f"{spec.name}: {len(dupes)} duplicated {spec.id_field} value(s)")
            out["counts"]["duplicate_sample"] = [d["_id"] for d in dupes[:5]]
    except Exception as exc:
        logger.warning("duplicate check failed on %s: %s", spec.name, exc)

    out["status"] = _worst(c["status"] for c in out["coverage"].values())
    return out


def audit_vectors(db, spec: CollectionSpec, tenant_id: str, source: dict) -> dict:
    """Chunk count, facet coverage, freshness, orphans, and embedding coverage."""
    name = f"{VECTOR_COLLECTION}_{spec.name}"
    out: Dict[str, Any] = {"collection": name, "exists": False, "total": 0,
                           "facets": {}, "status": "critical", "issues": []}
    if name not in db.list_collection_names():
        out["issues"].append(f"{name}: no vector collection — this source is "
                             f"invisible to semantic retrieval")
        return out

    col = db[name]
    out["exists"] = True
    scope = {"metadata.tenant_id": tenant_id}
    total = col.count_documents(scope)
    untagged = col.count_documents({"metadata.tenant_id": {"$exists": False}})
    out["total"] = total
    out["untagged_chunks"] = untagged
    if untagged:
        out["issues"].append(
            f"{name}: {untagged} chunk(s) carry no tenant_id and are reachable "
            f"by nobody")
    if not total:
        out["issues"].append(f"{name}: no chunks for this tenant")
        return out

    for facet in CHUNK_FACETS:
        n = col.count_documents({**scope, **_present([f"metadata.{facet}"])})
        ratio = _ratio(n, total)
        out["facets"][facet] = {"present": n, "ratio": ratio,
                                "status": _status(ratio, facet)}
        if ratio < 0.5:
            out["issues"].append(f"{name}: metadata.{facet} on {ratio:.0%} of chunks")

    # Freshness: how old is the newest chunk. A stale index answers yesterday's
    # question with confidence.
    newest = col.find_one(scope, {"metadata.created_at": 1},
                          sort=[("metadata.created_at", -1)])
    age_h = None
    created = (newest or {}).get("metadata", {}).get("created_at")
    if isinstance(created, datetime):
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        age_h = round((datetime.now(timezone.utc) - created).total_seconds() / 3600, 1)
        if age_h > FRESHNESS_CRIT_H:
            out["issues"].append(f"{name}: newest chunk is {age_h}h old")
    out["newest_chunk_age_hours"] = age_h

    # Embedding coverage and orphans, both computed from document ids.
    try:
        embedded_ids = set(col.distinct("metadata.document_id", scope))
        source_ids = {str(d["_id"]) for d in
                      db[spec.name].find({"tenant_id": tenant_id}, {"_id": 1})}
        embedded = len(embedded_ids & source_ids)
        orphans = len(embedded_ids - source_ids)
        out["documents_embedded"] = embedded
        out["documents_missing_vectors"] = len(source_ids) - embedded
        out["orphan_vector_documents"] = orphans
        ratio = _ratio(embedded, len(source_ids))
        out["embedded_ratio"] = ratio
        out["embedded_status"] = _status(ratio, "embedded")
        if ratio < 0.95:
            out["issues"].append(
                f"{name}: {len(source_ids) - embedded} of {len(source_ids)} "
                f"document(s) have no vectors")
        if orphans:
            out["issues"].append(
                f"{name}: {orphans} chunk group(s) reference documents that no "
                f"longer exist")
    except Exception as exc:
        logger.warning("embedding coverage failed on %s: %s", name, exc)

    statuses = [f["status"] for f in out["facets"].values()]
    statuses.append(out.get("embedded_status", "ok"))
    if age_h is not None:
        statuses.append("critical" if age_h > FRESHNESS_CRIT_H
                        else "warning" if age_h > FRESHNESS_WARN_H else "ok")
    out["status"] = _worst(statuses)
    return out


_ORDER = {"ok": 0, "informational": 0, "empty": 1, "warning": 2, "critical": 3}


def _worst(statuses) -> str:
    worst = "ok"
    for s in statuses:
        if _ORDER.get(s, 0) > _ORDER.get(worst, 0):
            worst = s
    return worst


# --------------------------------------------------------------------------- #
# report
# --------------------------------------------------------------------------- #

def audit_tenant(client: MongoClient, tenant_id: str, db_name: str) -> dict:
    db = client[db_name]
    report: Dict[str, Any] = {
        "tenant_id": tenant_id,
        "database": db_name,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sources": {}, "vectors": {}, "issues": [], "status": "ok",
    }

    for spec in SPECS:
        src = audit_source(db, spec, tenant_id)
        report["sources"][spec.name] = src
        report["issues"].extend(src["issues"])
        if spec.vectorised:
            vec = audit_vectors(db, spec, tenant_id, src)
            report["vectors"][spec.name] = vec
            report["issues"].extend(vec["issues"])

    report["status"] = _worst(
        [s["status"] for s in report["sources"].values()] +
        [v["status"] for v in report["vectors"].values()])
    report["summary"] = {
        "source_documents": sum(s["total"] for s in report["sources"].values()),
        "vector_chunks": sum(v.get("total", 0) for v in report["vectors"].values()),
        "issue_count": len(report["issues"]),
    }
    return report


def persist(client: MongoClient, db_name: str, report: dict) -> None:
    """Write a snapshot into the tenant's own database. Opt-in."""
    client[db_name][SNAPSHOT_COLLECTION].insert_one({**report, "at": datetime.now(timezone.utc)})


def render(report: dict) -> str:
    L = [
        "",
        f"  DATA QUALITY — tenant {report['tenant_id']}  ({report['database']})",
        f"  {report['generated_at']}   overall: {report['status'].upper()}",
        "  " + "─" * 86,
    ]

    L.append(f"  {'SOURCE':<14}{'DOCS':>7}  " + "  ".join(
        f"{k:>12}" for k in ("text", "published_at", "url", "handle", "districts")))
    for name, s in report["sources"].items():
        if s["total"] == 0:
            L.append(f"  {name:<14}{0:>7}  (empty)")
            continue
        cells = []
        for k in ("text", "published_at", "url", "handle", "districts"):
            c = s["coverage"].get(k)
            cells.append(f"{c['ratio']:>11.0%}{_mark(c['status'])}" if c else f"{'—':>12}")
        L.append(f"  {name:<14}{s['total']:>7}  " + "  ".join(cells))
        inh = s["coverage"].get("districts_inherited")
        if inh:
            total_linked = inh["present"] + inh["missing"]
            L.append(f"  {'':<14}{'':>7}  districts inherited: "
                     f"{inh['present']}/{total_linked} resolvable "
                     f"({s['counts'].get('parent_has_districts', 0)} with districts)")

    L.append("")
    L.append(f"  {'VECTORS':<14}{'CHUNKS':>7}  {'EMBEDDED':>10}  " + "  ".join(
        f"{k:>12}" for k in ("published_at", "url", "handle", "sentiment")))
    for name, v in report["vectors"].items():
        if not v.get("exists"):
            L.append(f"  {name:<14}{'—':>7}  MISSING COLLECTION")
            continue
        emb = v.get("embedded_ratio")
        cells = []
        for k in ("published_at", "url", "handle", "sentiment"):
            f_ = v["facets"].get(k)
            cells.append(f"{f_['ratio']:>11.0%}{_mark(f_['status'])}" if f_ else f"{'—':>12}")
        L.append(f"  {name:<14}{v['total']:>7}  "
                 f"{(f'{emb:.0%}' if emb is not None else '—'):>10}  " + "  ".join(cells))

    L += ["", f"  ISSUES ({len(report['issues'])})"]
    L += [f"    • {i}" for i in report["issues"]] or ["    none"]
    L.append("")
    return "\n".join(L)


def _mark(status: str) -> str:
    return {"ok": " ", "warning": "!", "critical": "X",
            "empty": " ", "informational": "~"}.get(status, " ")


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="corpus data-quality audit")
    ap.add_argument("--tenant", help="tenant_id to audit")
    ap.add_argument("--all-tenants", action="store_true")
    ap.add_argument("--json", help="write the full report to this path")
    ap.add_argument("--persist", action="store_true",
                    help="also store a snapshot in the tenant's ai_data_quality")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    if not args.tenant and not args.all_tenants:
        ap.error("pass --tenant <id> or --all-tenants")

    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    try:
        targets: List[tuple] = []
        if args.all_tenants:
            # Registry is shared with the political saga; active_tenants()
            # already filters by TENANT_TYPE, so this never crosses sagas.
            targets = [(t.id, t.db_name) for t in tenants.active_tenants()]
        else:
            targets.append((args.tenant, tenants.resolve_db_name(args.tenant)))

        reports = []
        for tenant_id, db_name in targets:
            if not tenant_id or not db_name:
                logger.warning("skipping tenant with no database mapping: %s", tenant_id)
                continue
            report = audit_tenant(client, tenant_id, db_name)
            reports.append(report)
            if not args.quiet:
                print(render(report))
            if args.persist:
                persist(client, db_name, report)

        if args.json:
            os.makedirs(os.path.dirname(os.path.abspath(args.json)), exist_ok=True)
            with open(args.json, "w", encoding="utf-8") as fh:
                json.dump(reports if len(reports) > 1 else reports[0], fh,
                          indent=2, default=str)
            print(f"  report written to {args.json}")

        # Exit code carries the worst status, so this can gate a deploy.
        worst = _worst([r["status"] for r in reports]) if reports else "critical"
        return {"ok": 0, "empty": 0, "warning": 1, "critical": 2}.get(worst, 2)
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
