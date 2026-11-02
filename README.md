# Idempotency and Duplicate-Safe Writes

Duplicate-safe `POST /incidents` endpoint that returns one durable result when the same logical request arrives more than once.

## Repository Structure

```text
.
├── db/
│   └── schema.sql              # incidents, idempotency_keys, paging_jobs tables
├── scripts/
│   └── resetDb.js              # recreates exercise database
├── src/
│   ├── app.js                  # Express route and error handler
│   ├── auth.js                 # provides authenticated exercise tenant/user
│   ├── db.js                   # PostgreSQL connection
│   └── incidents.js            # idempotent handler + hashRequest export
├── tests/
│   └── idempotency.test.js     # 14 supplied contract tests
├── docker-compose.yml          # local PostgreSQL on port 54329
├── package.json
└── package-lock.json
```

## Prerequisites

- Git, Node.js 18+, npm, Docker with Docker Compose, GitHub account

## Setup

```bash
git clone https://github.com/<your-username>/idempotency-and-duplicate-safe-writes.git
cd idempotency-and-duplicate-safe-writes
git checkout -b idempotent-incidents
docker compose up -d
npm install
npm run db:reset
npm test
```

---

## Design Decisions

### 1. Why database-level uniqueness is required

A `UNIQUE (tenant_id, operation, key)` constraint on `idempotency_keys` is the only mechanism that can atomically prevent duplicates across both sequential and concurrent requests. An application-level "check then insert" would have a race window between the SELECT and the INSERT. The constraint collapses that window to zero: the database engine serialises the two competing INSERTs at the storage layer and exactly one of them succeeds. Every other approach (advisory locks, optimistic retry with a version column) layers on top of this guarantee, not instead of it.

### 2. Canonical request hash

`hashRequest` sorts the body's keys alphabetically before calling `JSON.stringify`, then hashes the result with SHA-256 (Node's built-in `crypto` module, no external dependency). This means `{title, severity, serviceId}` and `{serviceId, title, severity}` produce identical digests. The hex digest is stored in `request_hash` so a later retry can detect whether the caller is replaying the same logical operation or has accidentally reused a key with different content (→ 409 `idempotency_key_conflict`).

### 3. What 24-hour expiry means

Each key row's `expires_at` is set to `now() + interval '24 hours'` when it is first inserted. The expiry answers the question "how long does the server remember this operation?" After 24 hours, the key is eligible for removal (a scheduled cleanup job could DELETE WHERE expires_at < now()). This window is long enough to cover any realistic network retry storm while preventing unbounded table growth. Clients that retry after the window will create a fresh incident, which is the correct behaviour once the original operation is clearly no longer in-flight.

### 4. Why the paging job lives in the same transaction

A paging job is a side-effect that must be durable if and only if the incident is durable. Committing the incident first and then creating the paging job in a second statement risks a partial failure where the incident exists but no one is ever paged. Wrapping both INSERTs in the same `db.tx` block and updating the idempotency key to `completed` in that same commit gives an all-or-nothing guarantee: either everything lands or nothing does. External queue calls (email, SMS) are intentionally placed outside the transaction because they cannot be rolled back; the paging job row serves as the durable record of intent that a separate dispatcher can process reliably.

### 5. Privacy and size risks of stored responses

The completed response body (the full incident row as JSON) is stored in `response_body JSONB` on the idempotency key row. Two risks follow:

- **Privacy**: the stored payload may contain tenant-sensitive fields. Access to `idempotency_keys` must be restricted to the application service account; no analytics or reporting role should be granted SELECT on this table. Rows should be purged on schedule once `expires_at` has passed.
- **Size**: large response bodies inflate the table. For `POST /incidents` the payload is small and bounded. For operations that return collections or file data, consider storing only the primary key(s) and reconstructing the full response on replay rather than storing the entire body.

---

## Implementation Summary

| Requirement | How it is met |
|---|---|
| Require one client idempotency key | `Idempotency-Key` header checked first; missing → 400 |
| Scope key by tenant + operation | Row keyed on `(tenant_id, 'POST:/incidents', key)` |
| Bind key to canonical request contents | SHA-256 of alphabetically-sorted JSON body stored and compared |
| Atomically prevent sequential + concurrent duplicates | `INSERT … ON CONFLICT (tenant_id, operation, key) DO NOTHING` inside a transaction |
| Replay completed result | Stored `response_status` + `response_body` returned with `Idempotent-Replayed: true` |
| Reject same key with changed request | Hash mismatch → 409 `idempotency_key_conflict` |
| Incident + paging job in one transaction | Both INSERTs and the key UPDATE share one `db.tx` commit |
| 24-hour expiry | `expires_at = now() + interval '24 hours'` on every key insert |

---

## Test Results

```
 PASS  tests/idempotency.test.js (15.954 s)
  ✓ 1 missing key returns 400 and no incident (2647 ms)
  ✓ 2 first request creates incident (233 ms)
  ✓ 3 sequential duplicate replays response (138 ms)
  ✓ 4 replay exposes replay header (192 ms)
  ✓ 5 changed body conflicts (176 ms)
  ✓ 6 same key across tenants is independent (179 ms)
  ✓ 7 twenty concurrent duplicates create one incident (541 ms)
  ✓ 8 concurrent duplicates create one paging job (343 ms)
  ✓ 9 lost-response retry produces one effect (133 ms)
  ✓ 10 existing processing key does not execute (93 ms)
  ✓ 11 existing failed key follows recovery contract (98 ms)
  ✓ 12 transaction rollback removes all local writes (113 ms)
  ✓ 13 canonical hash ignores object property order (70 ms)
  ✓ 14 operation and scope are stored exactly (93 ms)

Test Suites: 1 passed, 1 total
Tests:       14 passed, 14 total
```

## Troubleshooting

**Docker port conflict:** stop process using port 54329 or change port consistently in Compose and `DATABASE_URL`.

**Database connection failed:** wait until PostgreSQL is healthy (`docker compose ps`), then run `npm run db:reset` again.

**Tests say idempotency table is missing:** run `npm run db:reset` before running tests.

**Resetting production data:** never point `DATABASE_URL` at shared or production database. Reset script is destructive.
