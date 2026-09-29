import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { AppError, BodyParseError, TooLargeError, NotFoundError, ValidationError } from './errors.js';
import { signup, login, logout, requireSession } from './auth.js';
import { getOrg, getAccess } from './billing.js';
import { listDocs, createDoc, updateDoc, deleteDoc } from './knowledge.js';
import {
  startConversation, addVisitorMessage, visitorMessages,
  listConversations, getConversation, approveDraft, rejectDraft, manualReply, listAudit,
} from './conversations.js';
import {
  signupSchema, loginSchema, knowledgeCreateSchema, knowledgeUpdateSchema,
  approveSchema, replySchema, widgetMessageSchema,
} from './schemas.js';
import { rateLimit } from './ratelimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 200_000;

function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || 'unknown';
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      data += chunk;
      if (data.length > MAX_BODY) {
        settled = true;
        reject(new TooLargeError('Request body is too large.'));
        req.resume();
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new BodyParseError('Request body is not valid JSON.')); }
    });
    req.on('error', () => { if (!settled) { settled = true; reject(new BodyParseError('Could not read the request body.')); } });
  });
}

function handleError(res, err) {
  if (err instanceof AppError) return send(res, err.status, { error: err.code, message: err.message, issues: err.issues || undefined });
  console.error(err);
  return send(res, 500, { error: 'INTERNAL_ERROR', message: 'Something went wrong on our side.' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const headers = { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
  if (pathname === '/' || pathname === '/index.html') { headers['X-Frame-Options'] = 'DENY'; headers['Referrer-Policy'] = 'no-referrer'; }
  res.writeHead(200, headers);
  res.end(fs.readFileSync(filePath));
}

function meInfo(session) {
  const org = getOrg(session.organizationId);
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(session.userId);
  const docs = db.prepare(`SELECT COUNT(*) AS n FROM knowledge_documents WHERE organization_id = ? AND status = 'ACTIVE'`).get(org.id).n;
  const attention = db.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE organization_id = ? AND status IN ('awaiting_review','needs_owner')`).get(org.id).n;
  const convs = db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE organization_id = ?').get(org.id).n;
  const ev = db.prepare('SELECT event, COUNT(*) AS n FROM audit_log WHERE organization_id = ? GROUP BY event').all(org.id);
  const c = Object.fromEntries(ev.map((r) => [r.event, r.n]));
  return {
    stats: {
      drafted: c.AI_DRAFTED || 0, approved: c.REPLY_APPROVED || 0, edited: c.REPLY_EDITED || 0,
      rejected: c.REPLY_REJECTED || 0, blocked: c.AI_BLOCKED || 0, manual: c.MANUAL_REPLY || 0,
    },
    email: user.email,
    organization: { name: org.name, publicKey: org.public_key, planStatus: org.plan_status },
    access: getAccess(org),
    counts: { activeDocs: docs, conversations: convs, needAttention: attention },
    aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY) || process.env.AI_FOR_TESTS === '1',
  };
}

async function routeApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const m = req.method;
  const ip = clientIp(req);

  /* ---- public widget endpoints (used by the chat box on a customer's website) ---- */
  if (parts[0] === 'widget' && parts[1]) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Visitor-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (m === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const key = parts[1];
    const token = req.headers['x-visitor-token'];

    if (m === 'POST' && parts[2] === 'conversations' && !parts[3]) {
      rateLimit('widget-new:' + ip, 10, 600000);
      const body = widgetMessageSchema.parse(await readBody(req));
      return send(res, 201, startConversation(key, body.message));
    }
    if (parts[2] === 'conversations' && parts[3] && parts[4] === 'messages') {
      if (m === 'POST') {
        rateLimit('widget-msg:' + ip, 30, 60000);
        const body = widgetMessageSchema.parse(await readBody(req));
        addVisitorMessage(key, parts[3], token, body.message);
        return send(res, 201, { ok: true });
      }
      if (m === 'GET') {
        rateLimit('widget-poll:' + ip, 120, 60000);
        return send(res, 200, { messages: visitorMessages(key, parts[3], token) });
      }
    }
    throw new NotFoundError('Not found.');
  }

  /* ---- sign up / log in ---- */
  if (m === 'POST' && parts[0] === 'auth' && parts[1] === 'signup') {
    rateLimit('signup:' + ip, 10, 3600000);
    return send(res, 201, await signup(signupSchema.parse(await readBody(req))));
  }
  if (m === 'POST' && parts[0] === 'auth' && parts[1] === 'login') {
    rateLimit('login:' + ip, 10, 900000);
    return send(res, 200, await login(loginSchema.parse(await readBody(req))));
  }

  /* ---- everything below requires a logged-in session; the business comes from the session ---- */
  const session = requireSession(req);
  const orgId = session.organizationId;

  if (m === 'POST' && parts[0] === 'auth' && parts[1] === 'logout') { logout(session.token); return send(res, 200, { ok: true }); }
  if (m === 'GET' && parts[0] === 'me') return send(res, 200, meInfo(session));

  if (parts[0] === 'knowledge') {
    if (m === 'GET' && !parts[1]) return send(res, 200, { documents: listDocs(orgId) });
    if (m === 'POST' && !parts[1]) return send(res, 201, { document: createDoc(orgId, knowledgeCreateSchema.parse(await readBody(req))) });
    if (m === 'PUT' && parts[1]) {
      const patch = knowledgeUpdateSchema.parse(await readBody(req));
      if (!Object.keys(patch).length) throw new ValidationError('Nothing to update.');
      return send(res, 200, { document: updateDoc(orgId, parts[1], patch) });
    }
    if (m === 'DELETE' && parts[1]) { deleteDoc(orgId, parts[1]); return send(res, 200, { ok: true }); }
  }

  if (parts[0] === 'conversations') {
    if (m === 'GET' && !parts[1]) return send(res, 200, { conversations: listConversations(orgId) });
    if (m === 'GET' && parts[1] && !parts[2]) return send(res, 200, getConversation(orgId, parts[1]));
    if (m === 'POST' && parts[2] === 'reply') {
      manualReply(orgId, parts[1], replySchema.parse(await readBody(req)).body);
      return send(res, 201, { ok: true });
    }
    if (m === 'POST' && parts[2] === 'messages' && parts[3] && parts[4] === 'approve') {
      approveDraft(orgId, parts[1], parts[3], approveSchema.parse(await readBody(req)).editedBody);
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && parts[2] === 'messages' && parts[3] && parts[4] === 'reject') {
      await readBody(req);
      rejectDraft(orgId, parts[1], parts[3]);
      return send(res, 200, { ok: true });
    }
  }

  if (m === 'GET' && parts[0] === 'audit') return send(res, 200, { events: listAudit(orgId) });

  throw new NotFoundError('Not found.');
}

export function createApp() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await routeApi(req, res, url);
      if (req.method === 'GET') return serveStatic(res, url.pathname);
      res.writeHead(405); return res.end();
    } catch (err) {
      return handleError(res, err);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => {
    console.log(`SupportAI running on http://localhost:${port}`);
    if (!process.env.ANTHROPIC_API_KEY) console.log('NOTE: ANTHROPIC_API_KEY is not set, so the AI will not draft replies yet.');
  });
}
