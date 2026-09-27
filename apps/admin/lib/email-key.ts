import { createHash } from 'node:crypto';

/**
 * Opaque handle for an email address in console actions (e.g. unsuppress): pages send this instead of the
 * address, so a masked view never puts the clear address in the browser. Matches the SQL
 * `encode(sha256(convert_to(lower(email), 'UTF8')), 'hex')`.
 */
export const emailKey = (email: string) => createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
