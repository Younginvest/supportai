import crypto from 'node:crypto';
import { db, audit } from './db.js';
import { sha256 } from './auth.js';
import { getAccess } from './billing.js';
import { scheduleDraft } from './assistant.js';
import { rateLimit } from './ratelimit.js';
import { NotFoundError, StateError, UnavailableError, RateLimitError } from './errors.js';

const MAX_VISITOR_MESSAGES = 30;

/* ---------- visitor (chat box on the customer's website) ---------- */

export function orgByPublicKey(publicKey) {
  if (!/^pk_[a-f0-9]{24}$/.test(publicKey || '')) throw new NotFoundError('Chat not found.');
  const org = db.prepare('SELECT * FROM organizations WHERE public_key = ?').get(publicKey);
  if (!org) throw new NotFoundError('Chat not found.');
  return org;
}

function requireVisitorConversation(publicKey, conversationId, token) {
  const org = orgByPublicKey(publicKey);
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND organization_id = ?').get(conversationId || '', org.id);
  const notFound = new NotFoundError('Conversation not found.');
  if (!conv || typeof token !== 'string' || !token) throw notFound;
  const a = Buffer.from(sha256(token), 'hex');
  const b = Buffer.from(conv.visitor_token_hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw notFound; // same error either way
  return { org, conv };
}

function assertOrgAvailable(org) {
  if (!getAccess(org).allowed) throw new UnavailableError('This support chat is currently unavailable.');
}

export function startConversation(publicKey, message) {
  const org = orgByPublicKey(publicKey);
  assertOrgAvailable(org);
  rateLimit('org-conv:' + org.id, 200, 3600000); // protects the owner's AI bill from abuse
  const token = crypto.randomBytes(24).toString('base64url');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO conversations (id, organization_id, visitor_token_hash, status, created_at, updated_at)
              VALUES (?, ?, ?, 'open', ?, ?)`).run(id, org.id, sha256(token), now, now);
  insertVisitorMessage(org.id, id, message);
  audit(org.id, id, 'CONVERSATION_STARTED', '');
  scheduleDraft(org.id, id);
  return { conversationId: id, visitorToken: token };
}

function insertVisitorMessage(organizationId, conversationId, message) {
  db.prepare(`INSERT INTO messages (id, conversation_id, organization_id, role, state, body, created_at)
              VALUES (?, ?, ?, 'visitor', 'received', ?, ?)`)
    .run(crypto.randomUUID(), conversationId, organizationId, message, new Date().toISOString());
}

export function addVisitorMessage(publicKey, conversationId, token, message) {
  const { org, conv } = requireVisitorConversation(publicKey, conversationId, token);
  assertOrgAvailable(org);
  rateLimit('org-msg:' + org.id, 600, 3600000);
  const n = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'visitor'`).get(conv.id).n;
  if (n >= MAX_VISITOR_MESSAGES) throw new RateLimitError('This conversation has reached its message limit.');
  insertVisitorMessage(org.id, conv.id, message);
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), conv.id);
  scheduleDraft(org.id, conv.id);
}

/** Visitors only ever see their own messages and replies a human has approved. Never drafts. */
export function visitorMessages(publicKey, conversationId, token) {
  const { conv } = requireVisitorConversation(publicKey, conversationId, token);
  return db.prepare(`SELECT id, role, body, created_at FROM messages
                     WHERE conversation_id = ? AND (role = 'visitor' OR (role = 'agent' AND state = 'sent'))
                     ORDER BY rowid`).all(conv.id);
}

/* ---------- owner (dashboard) ---------- */

export function listConversations(organizationId) {
  return db.prepare(`
    SELECT c.id, c.status, c.created_at, c.updated_at,
      (SELECT body FROM messages m WHERE m.conversation_id = c.id AND m.role = 'visitor' ORDER BY m.rowid DESC LIMIT 1) AS last_visitor_message
    FROM conversations c WHERE c.organization_id = ? ORDER BY c.updated_at DESC LIMIT 100`).all(organizationId);
}

function requireOwnedConversation(organizationId, id) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND organization_id = ?').get(id, organizationId);
  if (!conv) throw new NotFoundError('Conversation not found.');
  return conv;
}

export function getConversation(organizationId, id) {
  const conv = requireOwnedConversation(organizationId, id);
  const messages = db.prepare(`SELECT id, role, state, body, sources, verification_status, verification_notes, created_at
                               FROM messages WHERE conversation_id = ? AND organization_id = ? ORDER BY rowid`)
    .all(id, organizationId).map((m) => ({ ...m, sources: m.sources ? JSON.parse(m.sources) : null }));
  return { conversation: conv, messages };
}

function requireDraft(organizationId, conversationId, messageId) {
  requireOwnedConversation(organizationId, conversationId);
  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ? AND organization_id = ?')
    .get(messageId, conversationId, organizationId);
  if (!msg) throw new NotFoundError('Message not found.');
  if (msg.role !== 'agent' || msg.state !== 'draft') throw new StateError('Only a waiting AI draft can be approved or rejected.');
  return msg;
}

export function approveDraft(organizationId, conversationId, messageId, editedBody) {
  const msg = requireDraft(organizationId, conversationId, messageId);
  const now = new Date().toISOString();
  if (editedBody) {
    db.prepare(`UPDATE messages SET state = 'sent', body = ?, verification_notes = ? WHERE id = ?`)
      .run(editedBody, 'Edited by a person before sending. Original AI draft: ' + msg.body.slice(0, 400), msg.id);
    audit(organizationId, conversationId, 'REPLY_EDITED', 'Owner edited the draft, then sent it');
  } else {
    db.prepare(`UPDATE messages SET state = 'sent' WHERE id = ?`).run(msg.id);
    audit(organizationId, conversationId, 'REPLY_APPROVED', 'Owner approved the draft as written');
  }
  db.prepare(`UPDATE conversations SET status = 'answered', updated_at = ? WHERE id = ?`).run(now, conversationId);
}

export function rejectDraft(organizationId, conversationId, messageId) {
  const msg = requireDraft(organizationId, conversationId, messageId);
  db.prepare(`UPDATE messages SET state = 'rejected' WHERE id = ?`).run(msg.id);
  db.prepare(`UPDATE conversations SET status = 'needs_owner', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), conversationId);
  audit(organizationId, conversationId, 'REPLY_REJECTED', 'Owner rejected the draft');
}

export function manualReply(organizationId, conversationId, body) {
  requireOwnedConversation(organizationId, conversationId);
  const now = new Date().toISOString();
  db.prepare(`UPDATE messages SET state = 'superseded' WHERE conversation_id = ? AND role = 'agent' AND state = 'draft'`).run(conversationId);
  db.prepare(`INSERT INTO messages (id, conversation_id, organization_id, role, state, body, verification_status, created_at)
              VALUES (?, ?, ?, 'agent', 'sent', ?, 'MANUAL', ?)`)
    .run(crypto.randomUUID(), conversationId, organizationId, body, now);
  db.prepare(`UPDATE conversations SET status = 'answered', updated_at = ? WHERE id = ?`).run(now, conversationId);
  audit(organizationId, conversationId, 'MANUAL_REPLY', 'Owner wrote a reply');
}

export function listAudit(organizationId) {
  return db.prepare('SELECT id, conversation_id, event, detail, created_at FROM audit_log WHERE organization_id = ? ORDER BY id DESC LIMIT 100').all(organizationId);
}
