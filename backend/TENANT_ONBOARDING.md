# Police Saga — Tenant Onboarding, End to End

How a police tenant goes from a form in the Super Admin UI to a running workspace
with its own database. Every file reference is relative to `police saga/backend/`.

---

## 1. The two planes

The single most important idea. A tenant's records live in **two different
databases**, and knowing which is which explains most of the design.

| | Control plane | Data plane |
|---|---|---|
| Database | `saga-super-admin` (`DB_NAME`) | `police_tenant_<slug>` |
| Holds | the `tenants` registry, `superadmins`, `counters`, `influencers` | the tenant's own 48 collections — users, alerts, content, grievances… |
| One per | deployment | tenant |
| Model style | `mongoose.model(...)` | `tenantModel(...)` |

The registry has to live somewhere reachable *before* we know which tenant a
request belongs to — `tenantMiddleware` resolves the host into a tenant by
querying it. If the registry itself lived in a per-tenant database, you would
need to know the tenant in order to find the tenant.

That is why `models/Tenant.js` is a plain `mongoose.model` while the other 48
model files are `tenantModel`.

> The control plane is **shared with the other Saga products and the Super
> Admin** — one `tenants` collection for all of them. `models/Tenant.js` scopes
> every query to `type: 'police'`, so this app can never resolve, list or delete
> another product's tenant.

---

## 2. Who talks to whom

```
Super Admin UI  ──►  Super Admin API  ──►  Police Saga API  ──►  MongoDB Atlas
   (:5173)             (:4000)               (:8001)
```

The browser never calls the police backend during onboarding. The Super Admin
API is the orchestrator and authenticates to the saga with a shared service key
(`SUPER_ADMIN_SERVICE_KEY`), not a user JWT.

---

## 3. The sequence

```mermaid
sequenceDiagram
    participant UI as Super Admin UI
    participant SA as Super Admin API :4000
    participant PS as Police Saga API :8001
    participant CP as saga-super-admin (control plane)
    participant TD as police_tenant_&lt;slug&gt; (data plane)

    UI->>SA: POST /api/tenants  { type:"police", … }
    SA->>SA: check permission manage_police_tenants
    SA->>PS: POST /api/super-admin/onboarding/complete<br/>x-service-key
    PS->>CP: resolve unique slug
    PS->>CP: admin email already used?
    PS->>CP: INSERT tenant record
    PS->>TD: provision — create 47 collections + indexes
    PS->>CP: stamp db_name + db_provisioned_at
    PS->>TD: seed admin user, settings, keywords
    PS->>CP: stamp admin_user_id
    PS-->>SA: { tenant, admin_credentials, subdomain_url }
    SA->>CP: mirror tenant config
    SA-->>UI: success dialog with credentials
```

---

## 4. Step by step

### Step 1 — Super Admin orchestrates
`superadmin/backend/src/controllers/superAdminController.js:195` — `createTenant`

Validates `type ∈ {political, police, state}`, checks the caller holds
`manage_police_tenants`, then forwards to the police backend.

```js
const backendUrl = type === 'police' ? POLICE_SAGA_API : STATE_SAGA_API;
const endpoint   = `${backendUrl}/api/super-admin/onboarding/complete`;
```

The call budget is **120 s** (`TENANT_ONBOARDING_TIMEOUT_MS`). Provisioning takes
tens of seconds against Atlas; the original 15 s expired mid-provision, so the
saga finished and created the tenant while the Super Admin reported a failure and
skipped the mirror write.

### Step 2 — Service-key gate
`src/routes/superAdminRoutes.js:62`

```js
router.post('/onboarding/complete', superAdminController.completeOnboarding);
```

The whole router sits behind `serviceKeyAuth`. These routes are mounted **above
`tenantMiddleware`** — a super admin arrives with no tenant subdomain — which is
why nothing downstream has a tenant in scope by default. That fact drives several
decisions below.

### Step 3 — Onboarding
`src/controllers/superAdminController.js:418` — `completeOnboarding`

**3a. Validate and normalise**

```js
if (!d.client_email || !appName) return res.status(400)…
d.client_email = String(d.client_email).toLowerCase().trim();
```

The email is lower-cased once here and reused for the uniqueness check, the
tenant record and the admin user, so it always matches the login lookup.

**3b. Resolve a unique slug** — from the SUBDOMAIN field, else the app name, else
the email prefix. Non-alphanumerics collapse to hyphens; collisions get a numeric
suffix.

```js
while (await Tenant.findOne({ slug })) { slug = `${base}-${n++}`; }
```

**3c. Check the admin email is free**

```js
const emailTaken = isPerTenant()
  ? await Tenant.findOne({ client_email: d.client_email })   // registry
  : await User.findOne({ email: d.client_email });           // shared users
```

In per-tenant mode there is no single `users` collection left to scan, and an
email only has to be unique *within* the tenant that owns it — a brand-new
tenant's database is empty, so nothing can collide. What must stay unique is the
admin email being onboarded, and that lives on the registry.

**3d. Password** — uses the one supplied, or generates a temporary one. Hashed
with bcrypt (10 rounds). The plaintext is returned **once**, in this response.

**3e. Write the tenant record** into the control plane, including:

| field | value |
|---|---|
| `id` | UUID — the real isolation key, never the slug |
| `slug` | resolved above |
| `domain` | `<slug>.<TENANT_BASE_DOMAIN>` — the host it answers on |
| `police_config` | department, state, districts, commandant |
| `status` | `active`, `trial_ends_at` +30 days |

### Step 4 — Build the tenant's database
`src/services/tenantProvisioningService.js:23` — `provisionTenantDatabase`

MongoDB has no "create database" step — a database exists once something is
written to it. So provisioning means: open the tenant's database, build every
collection and index the app expects, and record that it was done.

```js
const dbName     = dbNameFor(tenant);
const connection = forTenant(tenant);
const results    = await tenantSchemas.syncAllIndexes(connection);
```

Doing it up front means the first real request is not the one paying for index
builds, and a tenant with no traffic still shows up in backups and monitoring.

**If any model fails, provisioning throws.** A database missing collections is
not provisioned, and saying it is would be worse than failing — the tenant gets
stamped ready, onboarding reports success, and the problem surfaces on the first
request into a collection that was never built.

Then the resolved name is written back:

```js
await Tenant.updateOne({ id: tenant.id },
  { $set: { db_name: dbName, db_provisioned_at: new Date() } });
```

#### How the database name is chosen
`src/config/tenantConnections.js:34` — `dbNameFor`

```js
if (tenant.db_name) return sanitize(tenant.db_name);   // explicit wins
return sanitize(`${PREFIX}${tenant.slug || tenant.id}`);
```

`TENANT_DB_PREFIX=police_tenant_` + slug `hydpolice` → **`police_tenant_hydpolice`**.

Because provisioning writes `db_name` back, **renaming a slug later does not move
the database** — the derivation rule is a first-time default, not a permanent
binding. `sanitize()` strips characters Mongo rejects and truncates to 63 bytes.

### Step 5 — Seed the tenant's data
Still inside `completeOnboarding`, now with the tenant's database in scope:

```js
adminUserId = await runWithTenant(
  { tenant, tenantId, connection: forTenant(tenant) },
  async () => { … }
);
```

`runWithTenant` is required because this route has no tenant in scope. Inside it:

| seeded | behaviour |
|---|---|
| admin `User` | required — failure rolls the whole thing back |
| `Settings` | best-effort, logged and skipped on failure |
| default `Keyword`s | best-effort, category `other` |

### Step 6 — Respond
`admin_user_id` is stamped on the tenant (a control-plane write, so outside the
scope above), then:

```json
{
  "ok": true,
  "tenant": { "id": "…", "slug": "hydpolice", "type": "police" },
  "admin_credentials": { "email": "…", "password": "…", "temporary": false },
  "subdomain_url": "https://hydpolice.saga.in"
}
```

### Step 7 — Mirror
The Super Admin upserts the config it collected into its own view of the tenant.
Failures here are logged, never thrown — a mirror hiccup must not fail a real
create.

---

## 5. Failure handling

Onboarding is **atomic**. If provisioning or the admin-user seed fails, the
tenant record is deleted again:

```js
} catch (err) {
  await Tenant.deleteOne({ id: tenantId })…
  return res.status(500).json({ message: `Could not provision the tenant's database: ${err.message}` });
}
```

Without this, a failure leaves a tenant whose slug and client email are already
taken but which has no database and no admin user — impossible to log into and
impossible to create again, needing manual cleanup.

**Known gap:** the rollback removes the tenant record but does **not** drop a
partially-created database. It may be left behind occupying collections.

---

## 6. What exists afterwards

```
saga-super-admin.tenants     1 record   id, slug, domain, db_name, db_provisioned_at, admin_user_id
police_tenant_<slug>         47 collections
  ├── users        1   the admin
  ├── settings     1
  └── keywords     n   default keywords
```

---

## 7. How later requests find the tenant

Onboarding is only half the story — this is how the tenant is reached afterwards.

```
Host header
  ├─► domain column, exact match      ← wins; vanity hosts and "localhost"
  ├─► subdomain slug (3+ labels)      ← hydpolice.saga.in → "hydpolice"
  ├─► X-Tenant-Slug header            ← local/API testing
  └─► DEFAULT_TENANT_SLUG             ← local development fallback
```

1. **`middleware/tenantMiddleware.js:20`** resolves the host into `req.tenant`.
2. **`middleware/tenantDbMiddleware.js:11`** opens that tenant's database and
   enters the scope:
   ```js
   runWithTenant({ tenant, tenantId: tenant.id, connection }, next);
   ```
3. **`models/tenantModel.js:19`** — every tenant model is a proxy that resolves
   against whichever connection is in scope. This is why ~230 existing call sites
   (`Alert.find(...)`) needed no changes when data moved to a database per tenant.

Outside any scope, a tenant model **throws rather than guessing**. Falling back
to a default connection would read — and worse, write — the wrong database.

Two other entry points establish scope:

| caller | mechanism |
|---|---|
| Super Admin routes | `routes/superAdminRoutes.js:39` — `router.param('tenantId', …)` wraps `next()` in `runWithTenant`, covering all 65 `:tenantId` routes |
| schedulers, scripts | `forEachTenant(tenants, fn)` — one context per tenant |

> The router param exists because context must be established **around
> `next()`**. A helper that resolves a tenant and returns cannot do it —
> `AsyncLocalStorage.enterWith` does not propagate back across an `await`.

### Connections

`src/config/tenantConnections.js:49` — `forTenant`

```js
const connection = mongoose.connection.useDb(dbName, { useCache: true });
tenantSchemas.compileAll(connection);   // all models, so populate() works
```

`useDb` reuses the process's existing socket pool. 100 tenants cost 100 logical
database handles and **one** pool, not 100 pools. Each is cached by database name.

---

## 8. Configuration

| variable | where | purpose |
|---|---|---|
| `TENANT_DB_MODE` | saga | `per-tenant` or `shared`. Set back to `shared` to roll back |
| `TENANT_DB_PREFIX` | saga | `police_tenant_` — **must differ** from other sagas' prefix |
| `DB_NAME` | saga | control plane, `saga-super-admin` |
| `TENANT_BASE_DOMAIN` | saga | seeds `domain` and `subdomain_url` at creation |
| `DEFAULT_TENANT_SLUG` | saga | which tenant localhost resolves to |
| `SUPER_ADMIN_SERVICE_KEY` | both | service-to-service auth |
| `TENANT_ONBOARDING_TIMEOUT_MS` | super admin | default 120000 |

`TENANT_BASE_DOMAIN` is **load-bearing** — it is baked into each tenant's
`domain` at creation. Set it before onboarding real tenants, or they are all
stamped `*.saga.in`.

---

## 9. Operational notes

**Collection budget.** Each tenant costs ~47 collections. Atlas shared tiers cap
a cluster at **500 total**, so roughly 9 tenants. This binds long before anything
else does.

**Opening a database creates it.** Compiling models onto a connection builds
their indexes, which creates the collections. Any code that iterates tenants
materialises every tenant's database on contact — which is why the Super Admin
tenant list only opens tenants that are already provisioned.

**Deleting a tenant.** `?purge=true` drops the tenant's whole database in
per-tenant mode. Without `purge`, the record goes but the database remains,
still consuming the collection budget.

**Boot maintenance is skipped** in per-tenant mode — seeds and index repairs that
assumed one shared database no longer apply, and every tenant database is built
from current schemas by provisioning.
