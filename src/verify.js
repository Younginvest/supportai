/**
 * Checks a drafted reply against the business's own information, independent of the AI that wrote it.
 * Rule: any number, web link, or email address in the reply must literally appear in the cited
 * information (or in what the customer themself wrote). This catches invented prices, dates and contacts.
 * Limits (honest): it does not catch a wrong sentence made only of words. That is why a person still
 * approves every reply.
 */
const NUM = /\d[\d,]*(?:\.\d+)?/g;
const LINK = /https?:\/\/[^\s)]+|[\w.+-]+@[\w-]+\.[\w.-]+/gi;
const normNum = (s) => s.replace(/,/g, '').replace(/\.$/, '');
const numbersIn = (text) => new Set((text.match(NUM) || []).map(normNum));

export function verifyAnswer({ answer, citedDocs, visitorText }) {
  const issues = [];
  if (!citedDocs.length) issues.push('The reply does not cite any of your business information.');

  const source = citedDocs.map((d) => d.title + '\n' + d.body).join('\n');
  const allowedNumbers = new Set([...numbersIn(source), ...numbersIn(visitorText || '')]);
  for (const n of answer.match(NUM) || []) {
    if (!allowedNumbers.has(normNum(n))) issues.push(`The number "${n}" is not in your information.`);
  }

  const sourceLower = source.toLowerCase();
  const visitorLower = (visitorText || '').toLowerCase();
  for (const raw of answer.match(LINK) || []) {
    const l = raw.replace(/[.,;:]+$/, '').toLowerCase();
    if (!sourceLower.includes(l) && !visitorLower.includes(l)) issues.push(`The link or email "${raw}" is not in your information.`);
  }

  if (issues.length) return { status: 'FAIL', notes: issues.join(' ') };
  return { status: 'PASS', notes: 'Every number, link and email in this reply appears in your own information.' };
}
