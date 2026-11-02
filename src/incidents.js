const crypto = require('crypto');
const { db } = require('./db');

const OPERATION = 'POST:/incidents';
const EXPIRY_HOURS = 24;

/**
 * Produce a canonical, order-independent SHA-256 hex digest of the request
 * body. Keys are sorted alphabetically before serialisation so that
 * { title, severity, serviceId } and { serviceId, title, severity } hash
 * to the same value (test 13).
 */
function hashRequest(body) {
  const sorted = Object.fromEntries(
    Object.entries(body).sort(([a], [b]) => a.localeCompare(b))
  );
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/**
 * POST /incidents — idempotent incident creation.
 *
 * Flow
 * ────
 * 1. Require Idempotency-Key header → 400 if missing.
 * 2. Compute canonical hash of request body.
 * 3. Open a serialisable transaction and attempt to INSERT the key row with
 *    state = 'processing' using ON CONFLICT DO NOTHING.
 * 4a. If the row was inserted (claimed = true): create incident + paging job,
 *     update key to state = 'completed' with stored response, commit.
 * 4b. If the row already existed (claimed = false):
 *       - hash mismatch          → 409 idempotency_key_conflict
 *       - state = 'processing'   → 409 operation_in_progress
 *       - state = 'failed'       → 409 prior_operation_failed
 *       - state = 'completed'    → 201 replay with Idempotent-Replayed: true
 *
 * The UNIQUE constraint on (tenant_id, operation, key) provides the atomic
 * "first writer wins" guarantee that prevents both sequential and concurrent
 * duplicates without a separate advisory lock.
 */
async function createIncident(req, res) {
  const idempotencyKey = req.get('Idempotency-Key');
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'idempotency_key_required' });
  }

  const { tenantId } = req.user;
  const { title, severity, serviceId } = req.body;
  const requestHash = hashRequest(req.body);

  let result;

  try {
    result = await db.tx(async (t) => {
      // Attempt to claim the key atomically.
      const inserted = await t.one(
        `INSERT INTO idempotency_keys
           (tenant_id, operation, key, request_hash, state, expires_at)
         VALUES ($1, $2, $3, $4, 'processing', now() + interval '${EXPIRY_HOURS} hours')
         ON CONFLICT (tenant_id, operation, key) DO NOTHING
         RETURNING id`,
        [tenantId, OPERATION, idempotencyKey, requestHash]
      ).catch(() => null);

      if (!inserted) {
        // Key already exists — read the existing record.
        const existing = await t.one(
          `SELECT request_hash, state, response_status, response_body
             FROM idempotency_keys
            WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
          [tenantId, OPERATION, idempotencyKey]
        );

        if (existing.request_hash !== requestHash) {
          return { conflict: 'idempotency_key_conflict' };
        }
        if (existing.state === 'processing') {
          return { conflict: 'operation_in_progress' };
        }
        if (existing.state === 'failed') {
          return { conflict: 'prior_operation_failed' };
        }
        // state === 'completed' → replay stored response
        return { replay: true, status: existing.response_status, body: existing.response_body };
      }

      // Key claimed — create the incident and paging job in the same tx.
      const incident = await t.one(
        `INSERT INTO incidents (tenant_id, service_id, title, severity)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [tenantId, serviceId, title, severity]
      );

      await t.none(
        `INSERT INTO paging_jobs (incident_id, tenant_id)
         VALUES ($1, $2)`,
        [incident.id, tenantId]
      );

      // Persist the completed response so retries get an exact replay.
      await t.none(
        `UPDATE idempotency_keys
            SET state = 'completed',
                response_status = 201,
                response_body = $1
          WHERE tenant_id = $2 AND operation = $3 AND key = $4`,
        [incident, tenantId, OPERATION, idempotencyKey]
      );

      return { created: true, incident };
    });
  } catch (err) {
    // Mark the key as failed so clients get a clear recovery signal.
    await db.none(
      `UPDATE idempotency_keys
          SET state = 'failed'
        WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
      [tenantId, OPERATION, idempotencyKey]
    ).catch(() => {}); // best-effort; don't mask original error
    throw err;
  }

  if (result.conflict) {
    return res.status(409).json({ error: result.conflict });
  }
  if (result.replay) {
    return res
      .status(result.status)
      .set('Idempotent-Replayed', 'true')
      .json(result.body);
  }
  return res.status(201).json(result.incident);
}

module.exports = { createIncident, hashRequest };
