"""Shrink the migrated corpus to a storage-affordable, high-signal set.

The Atlas cluster caps at 512 MB of LOGICAL size (data + indexes, uncompressed).
Embedding all 23,077 migrated contents would need ~846 MB of vectors alone, so
the corpus has to be trimmed to something that fits.

Trimming by RISK rather than by date: keeping high + medium across the whole
migrated range beats keeping every risk level for three days. Same storage
budget, but "show me high risk posts in Hyderabad" then covers the full range
instead of a three-day slice, and what gets dropped is the low-risk chatter
("Thank you Anna") that was never worth retrieving.

What this removes:
  1. the partial vector_embeddings_contents collection (incomplete, regenerable)
  2. MIGRATED contents whose risk_level is not in --levels, and their analyses

What it never touches:
  - the legacy `tscan` database (read-only throughout, still holds everything)
  - contents that were in this tenant BEFORE the migration
    (matched on migrated_from == 'tscan', so the original 374 are safe at any risk level)

Recovery: everything deleted here still exists in `tscan`. Re-run
migrate_tscan.py to bring it back.

    python shrink_window.py                       # dry run
    python shrink_window.py --apply
    python shrink_window.py --levels high --apply # tighter still
"""

from __future__ import annotations

import argparse
import os
import sys

from dotenv import load_dotenv
from pymongo import MongoClient

HERE = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(HERE, ".env"))

TENANT = "e4b1ec57-ceff-4f3c-a33a-7b34e1fb71d2"
TENANT_DB = "police_tenant_t-scan"
MB = 1024 * 1024
QUOTA_MB = 512
KB_PER_CONTENT = 54.6      # measured: doc + analysis + ~2.6 vector chunks, incl. indexes


def usage(client) -> float:
    """Logical size across the whole cluster - what Atlas actually bills."""
    total = 0
    for name in client.list_database_names():
        if name in ("admin", "local", "config"):
            continue
        db = client[name]
        for col in db.list_collection_names():
            s = db.command("collstats", col)
            total += s.get("size", 0) + s.get("totalIndexSize", 0)
    return total / MB


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--levels", default="high,medium,critical",
                    help="risk levels to KEEP (comma separated)")
    ap.add_argument("--apply", action="store_true", help="actually delete; otherwise dry run")
    ap.add_argument("--keep-partial-vectors", action="store_true",
                    help="do not drop the incomplete vector_embeddings_contents")
    args = ap.parse_args()
    keep_levels = [x.strip().lower() for x in args.levels.split(",") if x.strip()]

    client = MongoClient(os.environ["MONGODB_URI"], serverSelectionTimeoutMS=8000)
    db = client[TENANT_DB]

    print(f"mode   : {'APPLY' if args.apply else 'DRY RUN'}")
    print(f"keep   : migrated contents with risk_level in {keep_levels}")
    print(f"         (pre-existing contents are kept regardless of risk)")
    before = usage(client)
    print(f"cluster: {before:.1f} MB / {QUOTA_MB} MB"
          f"{'   *** OVER QUOTA, WRITES BLOCKED ***' if before >= QUOTA_MB else ''}\n")

    migrated = {"tenant_id": TENANT, "migrated_from": "tscan"}
    doomed = {**migrated, "risk_level": {"$nin": keep_levels}}

    total_all = db.contents.count_documents({"tenant_id": TENANT})
    total_mig = db.contents.count_documents(migrated)
    pre_existing = total_all - total_mig
    n_drop = db.contents.count_documents(doomed)
    n_keep = total_all - n_drop

    print("current corpus by risk level:")
    for r in db.contents.aggregate([{"$match": {"tenant_id": TENANT}},
                                    {"$group": {"_id": "$risk_level", "n": {"$sum": 1}}},
                                    {"$sort": {"n": -1}}]):
        mark = "KEEP" if str(r["_id"]).lower() in keep_levels else "DROP (migrated only)"
        print(f"    {str(r['_id']):10} {r['n']:>7,}   {mark}")

    print(f"\ncontents in tenant        : {total_all:>7,}")
    print(f"  pre-existing (PROTECTED): {pre_existing:>7,}")
    print(f"  migrated                : {total_mig:>7,}")
    print(f"    to delete             : {n_drop:>7,}")
    print(f"  remaining after trim    : {n_keep:>7,}")

    drop_ids = [d["id"] for d in db.contents.find(doomed, {"id": 1}) if d.get("id")]
    n_an = 0
    if drop_ids:
        step = 5000
        for i in range(0, len(drop_ids), step):
            n_an += db.analyses.count_documents(
                {"tenant_id": TENANT, "content_id": {"$in": drop_ids[i:i + step]}})
    print(f"analyses to delete        : {n_an:>7,}")

    vec = "vector_embeddings_contents"
    has_vec = vec in db.list_collection_names()
    vec_mb = 0.0
    if has_vec:
        s = db.command("collstats", vec)
        vec_mb = (s.get("size", 0) + s.get("totalIndexSize", 0)) / MB
        print(f"partial {vec}: {s.get('count', 0):,} chunks, {vec_mb:.1f} MB"
              f"{' (keeping)' if args.keep_partial_vectors else ' -> DROP'}")

    print(f"\nprojected all-in cost of the kept corpus: {n_keep * KB_PER_CONTENT / 1024:.0f} MB")

    if not args.apply:
        print("\nDRY RUN - nothing deleted. Re-run with --apply")
        return 0

    print("\napplying...")
    if has_vec and not args.keep_partial_vectors:
        db.drop_collection(vec)
        print(f"  dropped {vec}  (+{vec_mb:.1f} MB)")

    # analyses first: an interruption then never strands analyses without a parent
    if drop_ids:
        step = 5000
        removed = 0
        for i in range(0, len(drop_ids), step):
            r = db.analyses.delete_many({"tenant_id": TENANT,
                                         "content_id": {"$in": drop_ids[i:i + step]}})
            removed += r.deleted_count
            print(f"  analyses {min(i + step, len(drop_ids)):,}/{len(drop_ids):,} deleted={removed:,}")
        print(f"  analyses deleted: {removed:,}")

    r = db.contents.delete_many(doomed)
    print(f"  contents deleted: {r.deleted_count:,}")

    # ---- verify -----------------------------------------------------------
    print("\nverifying...")
    left = db.contents.count_documents(doomed)
    still_pre = db.contents.count_documents({"tenant_id": TENANT}) - \
        db.contents.count_documents(migrated)
    live = {d["id"] for d in db.contents.find({"tenant_id": TENANT}, {"id": 1}) if d.get("id")}
    orphans = sum(1 for a in db.analyses.find({"tenant_id": TENANT}, {"content_id": 1})
                  if a.get("content_id") and a["content_id"] not in live)
    queued = db.contents.count_documents(
        {"tenant_id": TENANT, "analysis_status": {"$in": ["pending", "processing"]}})
    ok = (left == 0 and still_pre == pre_existing and orphans == 0 and queued == 0)
    print(f"  [{'PASS' if left == 0 else 'FAIL'}] no out-of-scope migrated contents left ({left})")
    print(f"  [{'PASS' if still_pre == pre_existing else 'FAIL'}] pre-existing contents untouched "
          f"({still_pre}/{pre_existing})")
    print(f"  [{'PASS' if orphans == 0 else 'FAIL'}] no orphaned analyses ({orphans})")
    print(f"  [{'PASS' if queued == 0 else 'FAIL'}] nothing queued for re-analysis ({queued})")

    after = usage(client)
    remaining = db.contents.count_documents({"tenant_id": TENANT})
    est_vec = remaining * 38.5 / 1024
    print(f"\ncluster: {before:.1f} MB -> {after:.1f} MB   freed {before - after:.1f} MB")
    print(f"headroom under quota: {QUOTA_MB - after:.1f} MB")
    print(f"vectors needed for the {remaining:,} remaining contents: {est_vec:.0f} MB"
          f"  -> {'FITS' if est_vec < QUOTA_MB - after else 'STILL TOO BIG'}")
    print("\nRESULT:", "PASS" if ok else "FAIL")
    print("\nNext:  .\\embed_all.ps1")
    print("Recovery: everything deleted is still in `tscan`:")
    print("          python migrate_tscan.py --days <N> --apply")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
