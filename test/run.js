import { seedFakeProvider } from './fake-provider.js';
import { createApp } from '../src/server.js';
import { drainJobs } from '../src/assistant.js';

function assert(cond, msg) { if (!cond) throw new Error('FAILED: ' + msg); console.log('  \u2713 ' + msg); }

seedFakeProvider();
const server = createApp();
await new Promise((r) => server.listen(0, r));
const base = 'http://localhost:' + server.address().port;

async function call(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

console.log('\n=== 1. Signup, and duplicate email is rejected ===');
let r = await call('POST', '/api/auth/signup', { email: 'owner@shop.test', password: 'correcthorse', businessName: 'Test Shop' });
assert(r.status === 201 && r.data.token, 'signup succeeds and returns a session token');
const token = r.data.token;
r = await call('POST', '/api/auth/signup', { email: 'owner@shop.test', password: 'different1', businessName: 'Dup' });
assert(r.status === 409, 'duplicate email is rejected, got ' + r.status);

console.log('\n=== 2. Login works, wrong password fails ===');
r = await call('POST', '/api/auth/login', { email: 'owner@shop.test', password: 'correcthorse' });
assert(r.status === 200 && r.data.token, 'login succeeds with correct password');
r = await call('POST', '/api/auth/login', { email: 'owner@shop.test', password: 'wrong-password' });
assert(r.status === 401, 'login fails with wrong password, got ' + r.status);

console.log('\n=== 3. No session at all is rejected on protected routes ===');
r = await call('GET', '/api/me', undefined, null);
assert(r.status === 401, 'no auth header returns 401, got ' + r.status);
r = await call('GET', '/api/me', undefined, 'not-a-real-token');
assert(r.status === 401, 'garbage token returns 401, got ' + r.status);

console.log('\n=== 4. Trial has not started until the first knowledge doc is added ===');
r = await call('GET', '/api/me', undefined, token);
assert(r.data.access.state === 'trial_not_started', 'trial_not_started before any info is added');

console.log('\n=== 5. Adding business info starts the trial ===');
r = await call('POST', '/api/knowledge', { title: 'Shipping', body: 'Standard shipping takes 5 to 7 business days. Express shipping costs $12 and arrives in 2 days.' }, token);
assert(r.status === 201, 'creating a knowledge doc succeeds');
r = await call('GET', '/api/me', undefined, token);
assert(r.data.access.state === 'trial', 'trial state becomes "trial" after first doc, got ' + r.data.access.state);
const publicKey = r.data.organization.publicKey;

console.log('\n=== 6. A malformed knowledge doc (missing body) is rejected with 400 ===');
r = await call('POST', '/api/knowledge', { title: 'Oops' }, token);
assert(r.status === 400, 'missing required field returns 400, got ' + r.status);

console.log('\n=== 7. Real customer conversation through the public widget endpoint ===');
r = await call('POST', `/api/widget/${publicKey}/conversations`, { message: 'How fast is express shipping and how much does it cost?' });
assert(r.status === 201 && r.data.conversationId, 'starting a conversation succeeds');
const convId = r.data.conversationId;
const visitorToken = r.data.visitorToken;

await drainJobs(); // the AI draft runs in the background; wait for it before checking

console.log('\n=== 8. The AI drafted a reply grounded in the real knowledge doc, held for review ===');
r = await call('GET', `/api/conversations/${convId}`, undefined, token);
const draft = r.data.messages.find((m) => m.role === 'agent' && m.state === 'draft');
assert(!!draft, 'a draft message exists and was not auto-sent');
assert(draft.body.includes('12') && draft.body.includes('2'), 'draft cites the real price and timeframe from the doc, not invented ones');
assert(draft.verification_status === 'PASS', 'the independent verification check passed the draft');
assert(r.data.conversation.status === 'awaiting_review', 'conversation status is awaiting_review');

console.log('\n=== 9. The visitor cannot see the draft, only sent messages ===');
r = await call('GET', `/api/widget/${publicKey}/conversations/${convId}/messages`, undefined, null);
r.headers = { 'X-Visitor-Token': visitorToken };
const vres = await fetch(base + `/api/widget/${publicKey}/conversations/${convId}/messages`, { headers: { 'X-Visitor-Token': visitorToken } });
const vdata = await vres.json();
assert(!vdata.messages.some((m) => m.role === 'agent'), 'visitor sees no agent message yet — the draft has not been approved');

console.log('\n=== 10. Owner approves the draft, then the visitor CAN see it ===');
r = await call('POST', `/api/conversations/${convId}/messages/${draft.id}/approve`, {}, token);
assert(r.status === 200, 'approve succeeds, got ' + r.status);
const vres2 = await fetch(base + `/api/widget/${publicKey}/conversations/${convId}/messages`, { headers: { 'X-Visitor-Token': visitorToken } });
const vdata2 = await vres2.json();
assert(vdata2.messages.some((m) => m.role === 'agent' && m.body.includes('12')), 'visitor now sees the approved reply');

console.log('\n=== 11. A wrong visitor token cannot read this conversation (tenant/visitor isolation) ===');
const badRes = await fetch(base + `/api/widget/${publicKey}/conversations/${convId}/messages`, { headers: { 'X-Visitor-Token': 'wrong-token-entirely' } });
assert(badRes.status === 404, 'wrong visitor token returns 404 (same as not-found, not a hint), got ' + badRes.status);

console.log('\n=== 12. A question NOT covered by the business info is escalated, not guessed ===');
r = await call('POST', `/api/widget/${publicKey}/conversations`, { message: 'Do you have a physical store I could visit in London?' });
const convId2 = r.data.conversationId;
await drainJobs();
r = await call('GET', `/api/conversations/${convId2}`, undefined, token);
assert(r.data.conversation.status === 'needs_owner', 'uncovered question is escalated to the owner, not answered, got ' + r.data.conversation.status);
assert(!r.data.messages.some((m) => m.role === 'agent' && m.state === 'draft'), 'no draft was created for an uncovered question');

console.log('\n=== 13. Owner can still reply manually on an escalated conversation ===');
r = await call('POST', `/api/conversations/${convId2}/reply`, { body: 'We only ship within the US right now.' }, token);
assert(r.status === 201, 'manual reply succeeds, got ' + r.status);

console.log('\n=== 14. A second business cannot see the first business\'s conversations (tenant isolation) ===');
r = await call('POST', '/api/auth/signup', { email: 'other@shop2.test', password: 'anotherpass1', businessName: 'Other Shop' });
const token2 = r.data.token;
r = await call('GET', `/api/conversations/${convId}`, undefined, token2);
assert(r.status === 404, "another business's session cannot read this conversation, got " + r.status);
r = await call('GET', '/api/conversations', undefined, token2);
assert(r.data.conversations.length === 0, "another business sees zero conversations, got " + r.data.conversations.length);

console.log('\n=== 15. Trial expiry blocks AI drafting but the widget still accepts messages for manual reply ===');
const { db } = await import('../src/db.js');
const orgRow = db.prepare('SELECT organization_id FROM sessions WHERE token_hash = (SELECT token_hash FROM sessions LIMIT 1)').get();
db.prepare(`UPDATE organizations SET trial_started_at = ? WHERE public_key = ?`).run(new Date(Date.now() - 30 * 86400000).toISOString(), publicKey);
r = await call('GET', '/api/me', undefined, token);
assert(r.data.access.state === 'expired', 'trial shows expired after backdating it, got ' + r.data.access.state);
r = await call('POST', `/api/widget/${publicKey}/conversations`, { message: 'Are you open on Sundays?' });
assert(r.status === 503, 'starting a NEW conversation after trial expiry is blocked with 503, got ' + r.status);

console.log('\n=== 16. Rate limiting protects the owner\'s AI bill from abuse ===');
db.prepare(`UPDATE organizations SET trial_started_at = ? WHERE public_key = ?`).run(new Date().toISOString(), publicKey);
let limited = false;
for (let i = 0; i < 12; i++) {
  const rr = await call('POST', `/api/widget/${publicKey}/conversations`, { message: 'test message ' + i });
  if (rr.status === 429) { limited = true; break; }
}
assert(limited, 'rapid repeated conversation-starts eventually get rate-limited (429)');

server.close();
await drainJobs();
console.log('\nAll checks passed against a real running server, a real database, and a fake-but-realistic AI provider.');
