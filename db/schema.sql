CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE incidents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  service_id  UUID NOT NULL,
  title       TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('P1','P2','P3','P4')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency key registry: one row per logical operation attempt.
-- The UNIQUE constraint on (tenant_id, operation, key) is the atomic
-- "first writer wins" lock that prevents duplicates.
CREATE TABLE idempotency_keys (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL,
  operation       TEXT        NOT NULL,          -- e.g. 'POST:/incidents'
  key             TEXT        NOT NULL,
  request_hash    TEXT        NOT NULL,          -- SHA-256 of canonical body
  state           TEXT        NOT NULL CHECK (state IN ('processing','completed','failed')),
  response_status INT,                           -- stored when state = 'completed'
  response_body   JSONB,                         -- stored when state = 'completed'
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, operation, key)
);

-- Durable paging jobs created atomically with each incident.
CREATE TABLE paging_jobs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID        NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  tenant_id   UUID        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
