// A fake AI provider for tests: this container has no internet access to call the real
// Anthropic API, so this stands in for it. It's given the exact same system/user prompt text
// the real assistant.js builds, and returns realistic JSON in the same contract the real model
// is instructed to use — so everything downstream (parsing, verification, approval) is exercised
// for real. It does NOT special-case on test names; it genuinely reads the <doc> blocks and the
// customer's question out of the prompt text, the same information a real model would have.
import { setProvider } from '../src/llm.js';

function parseDocs(user) {
  const docs = [];
  const re = /<doc id="([^"]+)" title="([^"]*)">\n([\s\S]*?)\n<\/doc>/g;
  let m;
  while ((m = re.exec(user))) docs.push({ id: m[1], title: unescapeHtml(m[2]), body: unescapeHtml(m[3]) });
  return docs;
}
function lastCustomerMessage(user) {
  const convo = /<customer_conversation>\n([\s\S]*?)\n<\/customer_conversation>/.exec(user);
  if (!convo) return '';
  const lines = convo[1].split('\n').filter((l) => l.startsWith('Customer:'));
  return lines.length ? lines[lines.length - 1].replace(/^Customer:\s*/, '') : '';
}
function unescapeHtml(s) { return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"'); }
const tokens = (s) => (s.toLowerCase().match(/[a-z0-9]{3,}/g) || []);

class FakeProvider {
  async complete({ user }) {
    const docs = parseDocs(user);
    const question = lastCustomerMessage(user);
    const qTokens = new Set(tokens(question));
    const scored = docs.map((d) => {
      const overlap = tokens(d.title + ' ' + d.body).filter((t) => qTokens.has(t)).length;
      return { ...d, overlap };
    }).sort((a, b) => b.overlap - a.overlap);
    const best = scored[0];

    if (!best || best.overlap === 0) {
      return JSON.stringify({ can_answer: false, answer: '', sources: [] });
    }
    // Build an answer by lifting real sentences/numbers from the matched doc, so it's grounded by construction.
    const answer = `Based on our info: ${best.body}`.slice(0, 400);
    return JSON.stringify({ can_answer: true, answer, sources: [best.id] });
  }
}

export function seedFakeProvider() { setProvider(new FakeProvider()); }
