"""Migrate legacy `tscan` records into the police_tenant_t-scan database.

READ-ONLY on the legacy database: it is only ever read from, never written,
dropped or re-indexed. Everything written goes to the tenant database.

    - every record is stamped tenant_id, districts and state
    - analyses are deduplicated to the LATEST one per content_id
    - analysis_status is never "pending", so the 14B worker will not pick
      migrated content up and re-analyse it
    - upserts use each collection's real unique index, so a re-run updates
      rather than duplicating, and the script is safe to stop and restart

Usage (PowerShell, from this directory):

    $env:TSCAN_URI = "mongodb://.../tscan?authSource=tscan"
    python migrate_tscan.py              # dry run, writes nothing
    python migrate_tscan.py --apply      # perform the migration
    python migrate_tscan.py --apply --days 90

The tenant's own MONGODB_URI is read from .env, as every other script here
does. TSCAN_URI is passed through the environment so the legacy credentials
are never stored in the repository.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from pymongo import MongoClient, UpdateOne
from pymongo.errors import BulkWriteError

HERE = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(HERE, ".env"))

TENANT_ID = "e4b1ec57-ceff-4f3c-a33a-7b34e1fb71d2"      # t-scan
TENANT_DB = "police_tenant_t-scan"
DISTRICTS = ["Hyderabad"]
STATE = "Telangana"
BATCH = 1000

# A migrated record must carry all of these or it is rejected rather than
# guessed at. Mirrors the tenant schema the rest of the platform expects.
REQUIRED = ["platform", "content_id", "content_url", "text",
            "author", "author_handle", "published_at"]


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def bulk(collection, ops, label: str) -> tuple:
    """Run a bulk upsert, tolerating duplicate-key races.

    A duplicate key here means the record is already present under another
    unique key, which is a skip, not a failure — aborting the batch would
    leave the migration half-applied.
    """
    if not ops:
        return 0, 0
    try:
        res = collection.bulk_write(ops, ordered=False)
        return res.upserted_count + res.modified_count, 0
    except BulkWriteError as exc:
        details = exc.details or {}
        errors = details.get("writeErrors", [])
        dupes = [e for e in errors if e.get("code") == 11000]
        if len(dupes) != len(errors):
            for e in errors:
                if e.get("code") != 11000:
                    log(f"  !! {label}: {e.get('code')} {str(e.get('errmsg'))[:200]}")
            raise
        written = details.get("nUpserted", 0) + details.get("nModified", 0)
        return written, len(dupes)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write; otherwise dry run")
    ap.add_argument("--days", type=int, default=30, help="how far back to migrate")
    args = ap.parse_args()

    tscan_uri = os.getenv("TSCAN_URI")
    if not tscan_uri:
        log("TSCAN_URI is not set. In PowerShell:")
        log('  $env:TSCAN_URI = "mongodb://user:pass@host:27017/tscan?authSource=tscan"')
        return 2

    legacy = MongoClient(tscan_uri, serverSelectionTimeoutMS=10000)["tscan"]
    tenant = MongoClient(os.environ["MONGODB_URI"], serverSelectionTimeoutMS=8000)[TENANT_DB]

    cutoff = datetime.now() - timedelta(days=args.days)
    started = datetime.now(timezone.utc)
    log(f"mode={'APPLY' if args.apply else 'DRY RUN'}  window={args.days}d "
        f"(since {cutoff:%Y-%m-%d})  districts={DISTRICTS}")

    # -- what the tenant already holds, so nothing is written twice ----------
    present = {(d.get("platform"), d.get("content_id"))
               for d in tenant.contents.find({"tenant_id": TENANT_ID},
                                             {"platform": 1, "content_id": 1})}
    log(f"tenant already holds {len(present)} contents")

    # -- 1. contents ---------------------------------------------------------
    log("reading legacy contents...")
    candidates = list(legacy.contents.find({"published_at": {"$gte": cutoff}}))
    fresh, already, rejected = [], 0, []
    for doc in candidates:
        if (doc.get("platform"), doc.get("content_id")) in present:
            already += 1
            continue
        missing = [f for f in REQUIRED if doc.get(f) in (None, "", [])]
        if missing:
            rejected.append((doc.get("content_id"), missing))
        else:
            fresh.append(doc)
    log(f"legacy contents in window : {len(candidates)}")
    log(f"  already in tenant       : {already}")
    log(f"  rejected (missing field): {len(rejected)}")
    log(f"  to migrate              : {len(fresh)}")

    # -- 2. latest analysis per content --------------------------------------
    wanted = {d["id"] for d in fresh if d.get("id")}
    log(f"scanning legacy analyses for the newest per content ({len(wanted)} wanted)...")
    newest: dict = {}
    scanned = 0
    for a in legacy.analyses.find({}, {"content_id": 1, "analyzed_at": 1}):
        scanned += 1
        if scanned % 200000 == 0:
            log(f"  ...{scanned} analyses scanned")
        cid = a.get("content_id")
        if cid in wanted:
            when = a.get("analyzed_at") or datetime.min
            if cid not in newest or when > newest[cid][1]:
                newest[cid] = (a["_id"], when)
    log(f"analyses scanned {scanned}; keeping {len(newest)} "
        f"({len(wanted) - len(newest)} contents have no analysis)")

    # -- 3. the sources those contents came from -----------------------------
    src_ids = {d.get("source_id") for d in fresh if d.get("source_id")}
    sources = list(legacy.sources.find({"id": {"$in": list(src_ids)}}))
    log(f"sources referenced: {len(src_ids)}; found in legacy: {len(sources)}")

    if not args.apply:
        log("")
        log("DRY RUN — nothing written. Re-run with --apply to migrate.")
        return 0

    # -- 4. write -------------------------------------------------------------
    def stamp(doc, extra=None):
        out = dict(doc)
        out.pop("_id", None)
        out["tenant_id"] = TENANT_ID
        out["districts"] = list(DISTRICTS)
        out["state"] = STATE
        out["migrated_from"] = "tscan"
        out["migrated_at"] = started
        if extra:
            out.update(extra)
        return out

    t0 = time.time()
    manifest = {"tenant_id": TENANT_ID, "districts": DISTRICTS, "source_db": "tscan",
                "window_days": args.days, "window_start": cutoff.isoformat(),
                "started_at": started.isoformat(), "content_ids": [], "source_ids": []}

    # sources — unique on (platform, identifier), NOT on id
    ops = [UpdateOne({"platform": s.get("platform"), "identifier": s.get("identifier")},
                     {"$set": stamp(s)}, upsert=True) for s in sources]
    n, skipped = bulk(tenant.sources, ops, "sources")
    manifest["source_ids"] = [s.get("id") for s in sources]
    log(f"sources: written={n} skipped_duplicate={skipped}")

    # contents — unique on (tenant_id, platform, content_id)
    written = dup = 0
    for i in range(0, len(fresh), BATCH):
        chunk = fresh[i:i + BATCH]
        ops = []
        for d in chunk:
            analysed = d.get("id") in newest
            ops.append(UpdateOne(
                {"tenant_id": TENANT_ID, "platform": d.get("platform"),
                 "content_id": d.get("content_id")},
                {"$set": stamp(d, {
                    # never "pending": that would queue it for the 14B worker
                    "analysis_status": "done" if analysed else "skipped",
                    "analysis_attempts": 0,
                    "analysis_skip_reason": None if analysed else "migrated without analysis",
                })},
                upsert=True))
        n, s = bulk(tenant.contents, ops, "contents")
        written += n
        dup += s
        manifest["content_ids"] += [d.get("content_id") for d in chunk]
        log(f"  contents {min(i + BATCH, len(fresh))}/{len(fresh)}  written={written} dup={dup}")
    log(f"contents: written={written} skipped_duplicate={dup}")

    # analyses — unique on (tenant_id, content_id)
    ids = [v[0] for v in newest.values()]
    awritten = adup = 0
    for i in range(0, len(ids), BATCH):
        docs = list(legacy.analyses.find({"_id": {"$in": ids[i:i + BATCH]}}))
        ops = [UpdateOne({"tenant_id": TENANT_ID, "content_id": a["content_id"]},
                         {"$set": stamp(a)}, upsert=True)
               for a in docs if a.get("content_id")]
        n, s = bulk(tenant.analyses, ops, "analyses")
        awritten += n
        adup += s
        log(f"  analyses {min(i + BATCH, len(ids))}/{len(ids)}  written={awritten} dup={adup}")
    log(f"analyses: written={awritten} skipped_duplicate={adup}")

    # -- 5. manifest ----------------------------------------------------------
    stamp_s = started.strftime("%Y%m%dT%H%M%SZ")
    path = os.path.join(HERE, "reports", f"tscan_migration_manifest_{stamp_s}.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    manifest["finished_at"] = datetime.now(timezone.utc).isoformat()
    manifest["counts"] = {"contents": written, "analyses": awritten,
                          "sources": len(sources), "rejected": len(rejected)}
    manifest["rejected"] = rejected[:500]
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1, default=str)

    log("")
    log(f"done in {time.time() - t0:.0f}s   manifest: {os.path.basename(path)}")
    for col in ("contents", "analyses", "sources"):
        log(f"  tenant {col:9} = {tenant[col].count_documents({'tenant_id': TENANT_ID})}")
    queued = tenant.contents.count_documents(
        {"tenant_id": TENANT_ID, "analysis_status": {"$in": ["pending", "processing"]}})
    log(f"  queued for analysis = {queued}  (must be 0: no re-analysis was requested)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
