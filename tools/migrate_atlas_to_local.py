#!/usr/bin/env python3
"""One-off copy of the t-scan data from MongoDB Atlas to the local MongoDB.

Run on the DGX Spark, which can reach both: Atlas directly, and the app
server's MongoDB through the SSH tunnel (127.0.0.1:27017).

    # 1. look first. Needs only the Atlas address; copies nothing.
    python tools/migrate_atlas_to_local.py --inspect

    # 2. copy
    DEST_PW=...  python tools/migrate_atlas_to_local.py --apply

    # 3. recreate the vector search indexes on the new database's mongot
    DEST_PW=...  python tools/migrate_atlas_to_local.py --search-indexes

What it will not do:
  * write to, modify or delete anything on Atlas. The source is only read.
  * overwrite a collection that already holds documents on the destination,
    unless --replace is given.
  * print any document. Output is database names, collection names and counts.

The source address comes from RAG_pipline_saga/.env (MONGODB_URI). The
destination password is never read from a file or stored: it comes from the
DEST_PW environment variable for the duration of one run.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path
from urllib.parse import quote_plus

from dotenv import dotenv_values
from pymongo import MongoClient
from pymongo.errors import OperationFailure
from pymongo.operations import SearchIndexModel

ROOT = Path(__file__).resolve().parents[1]
BATCH = 500

# The tenant's own database: everything in it is this department's.
TENANT_DB = "police_tenant_t-scan"

# The control database also holds OTHER tenants' registry records. Only this
# department's record is copied, never the others'.
CONTROL_DB = "saga-super-admin"
CONTROL_COLLECTIONS = ("tenants",)
TENANT_SLUG = "t-scan"


def _source() -> MongoClient:
    uri = dotenv_values(ROOT / "RAG_pipline_saga" / ".env").get("MONGODB_URI") \
        or os.environ.get("SRC_URI")
    if not uri:
        sys.exit("No source address: MONGODB_URI is not in RAG_pipline_saga/.env.")
    return MongoClient(uri, serverSelectionTimeoutMS=20000)


def _dest() -> MongoClient:
    pw = os.environ.get("DEST_PW", "")
    if not pw:
        sys.exit("DEST_PW is not set. Type it in for this run; it is not stored anywhere.")
    uri = (f"mongodb://tscanapp:{quote_plus(pw)}@127.0.0.1:27017/"
           "?authSource=admin&directConnection=true")
    return MongoClient(uri, serverSelectionTimeoutMS=20000)


def _filter_for(db: str, coll: str) -> dict:
    if db == CONTROL_DB and coll == "tenants":
        return {"slug": TENANT_SLUG}
    return {}


def _collections(db) -> list[str]:
    return sorted(c["name"] for c in db.list_collections()
                  if c.get("type", "collection") == "collection"
                  and not c["name"].startswith("system."))


# ----------------------------------------------------------------- inspect

def inspect() -> None:
    src = _source()
    for dbname in (TENANT_DB, CONTROL_DB):
        db = src[dbname]
        names = _collections(db)
        print(f"\n== {dbname}: {len(names)} collections ==")
        total = 0
        for n in names:
            flt = _filter_for(dbname, n)
            cnt = db[n].count_documents(flt)
            total += cnt
            try:
                si = len(list(db[n].list_search_indexes()))
            except OperationFailure:
                si = 0
            skip = ""
            if dbname == CONTROL_DB and n not in CONTROL_COLLECTIONS:
                skip = "   <- NOT copied (control DB: only 'tenants', filtered to this slug)"
            extra = f"  [{si} search index]" if si else ""
            print(f"  {n:42s} {cnt:>9,}{extra}{skip}")
        print(f"  {'total documents':42s} {total:>9,}")

    print("\n== registry records in the control database (names only) ==")
    for t in src[CONTROL_DB]["tenants"].find({}, {"slug": 1, "name": 1, "type": 1,
                                                  "status": 1, "_id": 0}):
        mark = "COPIED" if t.get("slug") == TENANT_SLUG else "not copied"
        print(f"  {str(t.get('slug')):22s} {str(t.get('type')):10s} {str(t.get('status')):10s} {mark}")


# ------------------------------------------------------------------- apply

def _copy_indexes(s, d) -> None:
    for name, info in s.index_information().items():
        if name == "_id_":
            continue
        opts = {k: v for k, v in info.items()
                if k in ("unique", "sparse", "expireAfterSeconds",
                         "partialFilterExpression", "collation")}
        keys = info["key"]
        if any(t == "text" for _, t in keys):
            # A text index is described by its weights, not its key list.
            weights = info.get("weights", {})
            keys = [(f, "text") for f in weights]
            opts["weights"] = weights
            opts["default_language"] = info.get("default_language", "english")
        d.create_index(keys, name=name, **opts)


def apply(replace: bool) -> int:
    src, dst = _source(), _dest()
    dst.admin.command("ping")
    failures = 0
    plan = [(TENANT_DB, _collections(src[TENANT_DB])),
            (CONTROL_DB, [c for c in _collections(src[CONTROL_DB]) if c in CONTROL_COLLECTIONS])]
    for dbname, names in plan:
        print(f"\n== {dbname} ==")
        for n in names:
            flt = _filter_for(dbname, n)
            s, d = src[dbname][n], dst[dbname][n]
            want = s.count_documents(flt)
            if d.estimated_document_count() > 0:
                if not replace:
                    print(f"  {n:42s} SKIPPED: destination already has data (use --replace)")
                    continue
                d.drop()
            t0, done, batch = time.time(), 0, []
            for doc in s.find(flt, batch_size=BATCH):
                batch.append(doc)
                if len(batch) >= BATCH:
                    d.insert_many(batch, ordered=False)
                    done += len(batch)
                    batch = []
            if batch:
                d.insert_many(batch, ordered=False)
                done += len(batch)
            try:
                _copy_indexes(s, d)
                idx_note = ""
            except Exception as exc:  # noqa: BLE001  an index failure must not hide the data copy
                idx_note = f"  (index problem: {str(exc)[:70]})"
            have = d.count_documents({})
            ok = "ok" if have == want else f"MISMATCH source={want} dest={have}"
            failures += have != want
            print(f"  {n:42s} {have:>9,} / {want:<9,} {ok}  {time.time() - t0:5.1f}s{idx_note}")
    print("\nRESULT:", "all collections match" if not failures else f"{failures} collection(s) DO NOT match")
    return failures


# ----------------------------------------------------------- search indexes

def search_indexes() -> int:
    src, dst = _source(), _dest()
    wanted = []
    for n in _collections(src[TENANT_DB]):
        for idx in src[TENANT_DB][n].list_search_indexes():
            wanted.append((n, idx))
    if not wanted:
        print("No search indexes on the source; nothing to create.")
        return 0
    d_db = dst[TENANT_DB]
    for n, idx in wanted:
        have = {i["name"] for i in d_db[n].list_search_indexes()}
        if idx["name"] in have:
            print(f"  {n}: '{idx['name']}' already exists")
            continue
        d_db[n].create_search_index(SearchIndexModel(
            definition=idx["latestDefinition"], name=idx["name"],
            type=idx.get("type", "search")))
        print(f"  {n}: creating '{idx['name']}' ({idx.get('type', 'search')})")

    print("\nwaiting for the indexes to build (this is mongot reading the data)...")
    deadline = time.time() + 600
    while time.time() < deadline:
        pending = []
        for n, idx in wanted:
            for i in d_db[n].list_search_indexes():
                if i["name"] == idx["name"] and not i.get("queryable"):
                    pending.append(f"{n}:{i.get('status')}")
        if not pending:
            print("all search indexes are queryable")
            return 0
        print("  still building:", ", ".join(pending))
        time.sleep(10)
    print("TIMED OUT waiting for the indexes; check `journalctl -u mongot` on the app server")
    return 1


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--inspect", action="store_true", help="list what would be copied; copies nothing")
    g.add_argument("--apply", action="store_true", help="copy the data")
    g.add_argument("--search-indexes", action="store_true", help="recreate the vector search indexes")
    ap.add_argument("--replace", action="store_true",
                    help="with --apply: drop and refill a destination collection that already has data")
    a = ap.parse_args()
    if a.inspect:
        inspect()
    elif a.apply:
        sys.exit(1 if apply(a.replace) else 0)
    else:
        sys.exit(search_indexes())


if __name__ == "__main__":
    main()
