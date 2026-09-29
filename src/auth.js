import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db, audit } from './db.js';
import { AuthError, ConflictError } from './errors.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const DUMMY_HASH = await hashPassword('dummy-password-for-timing');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(userId, organizationId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, organization_id, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, organizationId, expires);
  return token;
}

export async function signup({ email, password, businessName }) {
  const normalized = email.toLowerCase();
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(normalized)) {
    throw new ConflictError('An account with this email already exists.');
  }
  const passwordHash = await hashPassword(password);
  const orgId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  const publicKey = 'pk_' + crypto.randomBytes(12).toString('hex');

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO organizations (id, name, public_key, created_at) VALUES (?, ?, ?, ?)')
      .run(orgId, businessName, publicKey, now);
    db.prepare('INSERT INTO users (id, organization_id, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, orgId, normalized, passwordHash, now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    if (String(e.message).includes('UNIQUE')) throw new ConflictError('An account with this email already exists.');
    throw e;
  }
  audit(orgId, null, 'ORG_CREATED', businessName);
  return { token: createSession(userId, orgId) };
}

export async function login({ email, password }) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  // Always do the same amount of hashing work so response time doesn't reveal whether the email exists.
  const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) throw new AuthError('UNAUTHENTICATED', 'Email or password is incorrect.');
  audit(user.organization_id, null, 'LOGIN', '');
  return { token: createSession(user.id, user.organization_id) };
}

export function logout(token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function tokenFromRequest(req) {
  const m = /^Bearer\s+(.+)$/i.exec((req.headers['authorization'] || '').trim());
  return m ? m[1].trim() : null;
}

/** Who is calling? The organization ALWAYS comes from the session, never from the URL or body. */
export function requireSession(req) {
  const token = tokenFromRequest(req);
  if (!token) throw new AuthError('UNAUTHENTICATED', 'Please log in.');
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!row || Date.parse(row.expires_at) < Date.now()) {
    throw new AuthError('UNAUTHENTICATED', 'Your session has expired. Please log in again.');
  }
  return { userId: row.user_id, organizationId: row.organization_id, token };
}

export { sha256 };
