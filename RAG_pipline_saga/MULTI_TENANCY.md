# Multi-tenancy in the RAG service

Two boundaries, enforced in different places.

| | boundary | where it lives | what it separates |
|---|---|---|---|
| 1 | **Tenant** | a whole MongoDB database | one customer from another |
| 2 | **District** | `metadata.districts` on each chunk | one officer's jurisdiction from another's, inside a tenant |

## 1. Tenants are separated by database

Every tenant owns a database. Its vectors are written **into that same
database**, beside the collections they were built from:

```
police_tenant_t-scan
├── alerts, grievances, contents, …        ← source data (written by the backend)
├── vector_embeddings_alerts               ← vectors for those alerts
├── vector_embeddings_grievances
└── rag_jobs                               ← this tenant's async questions
```

Nothing about one tenant's corpus is stored anywhere another tenant can reach,
and no query can name another tenant's database: `_tenant_db()` resolves the
name from the registry and raises for an unknown tenant rather than falling
back to a default.

### The naming rule must match the backend

`tenants.db_name_for` mirrors the backend's
`config/tenantConnections.dbNameFor` exactly:

```
explicit tenant.db_name   →  used as-is (sanitised)
otherwise                 →  TENANT_DB_PREFIX + slug
```

**If these two drift, nothing errors.** This service indexes a database the
application never writes to, and every answer comes back empty. `TENANT_DB_PREFIX`
must be identical in `backend/.env` and here. `test_tenant_db.py` pins the rule.

### The control plane is shared between sagas

One registry holds both products' tenants:

```
t-scan   type=police   db_name=police_tenant_t-scan
bjp      type=state    db_name=state_tenant_bjp
ysrcp    type=state    db_name=state_tenant_ysrcp
```

Every registry read is filtered by `TENANT_TYPE`, so this service can neither
resolve nor ingest the political-state saga's databases. Set `TENANT_TYPE=police`
here and `state` in a political deployment.

### A new tenant needs no deployment

Creating a tenant in Super Admin creates its database. The scheduler reads the
registry at the start of each cycle, so the next cycle ingests the new tenant
and its vector collections are created on first write. Nothing to restart.

## 2. Districts separate officers inside a tenant

Every chunk is tagged at ingest:

```python
"tenant_id":  doc.get("tenant_id", tenant_id),
"districts":  link_districts_map.get(doc.get(link_field), [])
              if link_field else doc.get("districts", []),
```

Collections with no districts of their own inherit them from a parent — alerts
from the monitored profile via `source_id`, the report kinds from their
grievance via `grievance_id`.

At query time, `cosine_search` masks anything outside the caller's scope.

### `None` and `[]` are not the same thing

This is the distinction that breaks quietly:

| value | means | behaviour |
|---|---|---|
| `districts=None` | State Admin, no scoping requested | unrestricted within the tenant |
| `districts=[]` | officer with **zero** districts assigned | **matches nothing** |

Both are falsy in Python. Collapsing them hands a districtless officer the whole
tenant. The Node proxy already sends exactly this: `null` for an admin,
`req.user.districts || []` otherwise.

A chunk with no districts of its own is tenant-wide and stays visible to
everyone in the tenant — the same convention as the backend's
`scopedDistrictQuery`.

### `tenant_id` is still tagged, and still filtered

Redundant now that vectors live in the tenant's own database, and deliberately
kept. If this service is ever pointed at a shared database, or a tenant is
merged, the tag is what stops a cross-tenant read.

## Configuration

```bash
MONGODB_URI=            # same cluster as the backend
CONTROL_DB_NAME=saga-super-admin   # the registry, NOT a tenant database
TENANT_DB_PREFIX=police_tenant_    # MUST match backend/.env
TENANT_TYPE=police                 # which saga's tenants this service serves
TENANT_REGISTRY_TTL_S=300          # how long a resolved tenant is cached

RAG_MAX_WARM_STORES=24             # memory ceiling for retrieval, see below
```

## Optimisation

**Warm stores are bounded and LRU.** Each warm store holds its collection's
vectors as a numpy array. With `T` tenants × `C` collections that grows without
limit, so `_GLOBAL_STORES` keeps the most recently used `RAG_MAX_WARM_STORES`
and closes the rest. Raise it on a machine with headroom; a tenant evicted
between questions pays one cache reload, not a re-embed.

**Caches are per database on disk:** `.vector_cache/<database>/<collection>_embeddings.npy`.
A flat directory would have the first tenant to warm a collection serving its
vectors to every other.

**The registry is cached for `TENANT_REGISTRY_TTL_S`**, so a question costs no
extra round trip. `tenants.invalidate()` drops it when a tenant is renamed or
moved.

**Ingest is incremental per tenant.** A content hash per document means
unchanged data never reaches the embedding model, so a cycle across many
tenants re-embeds only what actually changed.

## Running it

```bash
python -m pytest test_isolation.py test_tenant_db.py -q   # 37 tests
python -m uvicorn api_server:app --host 0.0.0.0 --port 8100
```

The backend reaches it through `RAG_API_URL` (default `http://localhost:8100`).
The Node proxy injects `tenant_id` and `districts` on every call; this service
rejects a data request without a tenant rather than answering it unscoped.

### Backfilling an existing corpus

Chunks written before tagging carry no `tenant_id` and are **reachable by
nobody** — the safe direction, but it means the corpus is empty until re-ingested:

```bash
curl -X POST localhost:8100/api/rag/ingest \
  -H 'Content-Type: application/json' \
  -d '{"collection":"alerts","tenant_id":"<id>","force":true}'
```

`force` bypasses the content-hash skip so existing chunks are re-embedded and
re-tagged in place.

## On-demand concept scans

Questions naming a concept no record is tagged with ("communal content last
7 days", "which are international, national, local") run as a scan
(`scan.py`): filter -> recall (expanded terms + vectors) -> rerank -> LLM
judge -> cache. Two collections are written, both inside the tenant's own
database, never a shared one:

| Collection | Holds |
|---|---|
| `rag_verdicts` | one verdict per (concept, record, content hash), with the judge's reason |
| `rag_concept_terms` | a concept's multilingual search terms, generated once |

The window query goes through `retriever.build_filter`, so the tenant and
district clauses apply exactly as in every other retriever. A scan job can be
read only with the tenant AND district scope that started it. Jobs live in
process memory: run the API as a single worker.
