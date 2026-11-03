import { cancelJobs } from './delivery.js';

// A confirmed grant can be fetched again only for idempotent client retries; then its plaintext is erased.
export const confirmReplay = 600000;

// Deletes up to `limit` expired registrations and cancels their work in the same transaction, so expiry never
// leaves queued work behind. Returns how many were deleted.
export async function expireRegistrations(db, now, limit = 1000) {
  return db.transaction(async () => {
    const expired = await db
      .prepare(
        `DELETE FROM registrations WHERE id IN
        (SELECT id FROM registrations WHERE expires<=? ORDER BY expires LIMIT ?)
        AND expires<=? RETURNING id`,
      )
      .all(now, limit, now);
    if (expired.length)
      await cancelJobs(db, now, 'RegistrationExpired', 'registration_id=ANY(?::text[])', [expired.map(r => r.id)]);
    return expired.length;
  });
}

// Every expiry the request paths rely on, in one place: rows past their lifetime are removed, and plaintext grants
// past the confirmation retry window are erased.
export async function cleanupExpired(db, now) {
  await db.prepare('DELETE FROM abuse_quotas WHERE expires<=?').run(now);
  for (const table of ['integrity_challenges', 'integrity_keys', 'server_tickets'])
    await db.prepare(`DELETE FROM ${table} WHERE expires<=?`).run(now);
  // Rows confirmed before confirmed_at existed have no retry window left.
  await db
    .prepare(
      `UPDATE registrations SET credentials=NULL,challenge_hash=NULL WHERE id IN
      (SELECT id FROM registrations WHERE challenge_hash IS NOT NULL AND delivery_hash IS NOT NULL
      AND (confirmed_at IS NULL OR confirmed_at<=?) LIMIT 1000)`,
    )
    .run(now - confirmReplay);
  await expireRegistrations(db, now);
}
