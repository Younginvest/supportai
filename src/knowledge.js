import crypto from 'node:crypto';
import { db, audit } from './db.js';
import { NotFoundError, ValidationError } from './errors.js';

const MAX_DOCS = 100;

export function listDocs(organizationId) {
  return db.prepare(`SELECT id, title, body, status, created_at, updated_at FROM knowledge_documents
                     WHERE organization_id = ? ORDER BY created_at DESC, rowid DESC`).all(organizationId);
}

export function createDoc(organizationId, { title, body }) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM knowledge_documents WHERE organization_id = ?').get(organizationId).n;
  if (count >= MAX_DOCS) throw new ValidationError(`You can store up to ${MAX_DOCS} information entries.`);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO knowledge_documents (id, organization_id, title, body, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)`).run(id, organizationId, title, body, now, now);
  // Trial clock starts with the first entry.
  db.prepare('UPDATE organizations SET trial_started_at = ? WHERE id = ? AND trial_started_at IS NULL').run(now, organizationId);
  audit(organizationId, null, 'KNOWLEDGE_CREATED', title);
  return getDoc(organizationId, id);
}

export function getDoc(organizationId, id) {
  const row = db.prepare('SELECT * FROM knowledge_documents WHERE id = ? AND organization_id = ?').get(id, organizationId);
  if (!row) throw new NotFoundError('Information entry not found.');
  return row;
}

export function updateDoc(organizationId, id, patch) {
  const cur = getDoc(organizationId, id);
  const next = {
    title: patch.title ?? cur.title,
    body: patch.body ?? cur.body,
    status: patch.status ?? cur.status,
  };
  db.prepare('UPDATE knowledge_documents SET title = ?, body = ?, status = ?, updated_at = ? WHERE id = ? AND organization_id = ?')
    .run(next.title, next.body, next.status, new Date().toISOString(), id, organizationId);
  audit(organizationId, null, 'KNOWLEDGE_UPDATED', next.title);
  return getDoc(organizationId, id);
}

export function deleteDoc(organizationId, id) {
  const cur = getDoc(organizationId, id);
  db.prepare('DELETE FROM knowledge_documents WHERE id = ? AND organization_id = ?').run(id, organizationId);
  audit(organizationId, null, 'KNOWLEDGE_DELETED', cur.title);
}

const STOP = new Set(['the', 'and', 'for', 'you', 'your', 'are', 'with', 'this', 'that', 'have', 'what', 'how', 'can', 'does', 'from', 'was', 'were', 'will', 'not', 'but', 'about', 'any', 'its', 'our', 'there', 'their', 'they', 'them']);
const tokens = (s) => (s.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((t) => !STOP.has(t));

/**
 * Picks which of THIS organization's active entries to show the AI. Small businesses have few
 * entries, so we include as many as fit in the budget, best matches first.
 */
export function retrieveDocs(organizationId, queryText, budgetChars = 12000) {
  const docs = db.prepare(`SELECT id, title, body FROM knowledge_documents
                           WHERE organization_id = ? AND status = 'ACTIVE'`).all(organizationId);
  const q = new Set(tokens(queryText));
  const scored = docs.map((d) => {
    const titleT = tokens(d.title);
    const bodyT = tokens(d.body);
    let score = 0;
    for (const t of titleT) if (q.has(t)) score += 3;
    for (const t of bodyT) if (q.has(t)) score += 1;
    return { ...d, score };
  }).sort((a, b) => b.score - a.score);

  const picked = [];
  let used = 0;
  for (const d of scored) {
    const size = d.title.length + d.body.length;
    if (used + size > budgetChars) continue;
    picked.push(d);
    used += size;
  }
  return picked.map((d, i) => ({ label: 'd' + (i + 1), id: d.id, title: d.title, body: d.body }));
}
