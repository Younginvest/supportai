# AI Workforce — web MVP (Customer Support role, live end to end)

This is the web product from our conversation: a landing page framed as "hire AI
employees," with three profiles shown (Customer Support live, Executive Assistant
and Operations marked "Coming soon" — no invented reviews or stats on any of them),
a real signup/trial/dashboard flow, and a real embeddable chat widget.

## What's actually real

- **Accounts & sessions** — password hashing (scrypt), timing-safe login, session
  tokens, one business's account fully isolated from another's (tested).
- **Trial gating** — the trial clock starts when a business adds its first piece
  of information, not at signup, and blocks new AI replies once it expires
  (`src/billing.js`). `src/admin.js` is the one manual lever to mark someone
  as a paying customer once you've agreed a price with them — there's no
  payment processor wired in yet, since we haven't picked one (Paddle / Lemon
  Squeezy / Polar were the candidates from our conversation).
- **The AI pipeline** — a real customer message comes in through the widget,
  retrieval picks the business's own relevant info, a model call drafts a
  reply, an independent verification step (`src/verify.js`) checks every
  number/link/email in the draft actually appears in the cited info, and
  nothing reaches the customer until a person approves it (`src/assistant.js`,
  `src/conversations.js`).
- **The widget** (`public/widget.js`) — a real embeddable chat bubble a
  business pastes onto their own site. It's on this app's own landing page
  too, so you can try it on yourself first.
- **Multi-tenant isolation** and **visitor/owner separation** are both tested
  over real HTTP, not assumed.

## What's honestly not real yet

- **No live model call has been run from this sandbox** — no internet access
  here. `test/fake-provider.js` stands in for it in tests, reading the exact
  same prompt real assistant.js builds and answering realistically, so the
  rest of the pipeline (parsing, verification, approval) is genuinely
  exercised. Set `ANTHROPIC_API_KEY` and this becomes real; nothing else
  changes.
- **Executive Assistant and Operations are not built.** They're shown on the
  landing page as "Coming soon" with a short description of planned scope,
  exactly so the site doesn't overclaim.
- **No payment processor is wired in.** Pricing is intentionally left as
  "we'll agree a plan with you directly" on the profile page, since no price
  or processor has been decided.
- **No Shopify or email/inbox integration.** Customer info is entered by hand
  on the "Business info" tab. That's what makes this workable for startups
  today without waiting on Shopify's review process.

## Running it

```
node src/seed.js 2>/dev/null; true   # (no seed script needed — signup creates your org)
ANTHROPIC_API_KEY=sk-ant-... node src/server.js
```

Open `http://localhost:3000`, sign up, add a couple of pieces of business
info, then use the chat bubble in the corner (same widget a real customer
would see) to try asking a question. Approve/reject the AI's draft from the
dashboard's Conversations tab.

Without `ANTHROPIC_API_KEY` set, the app still runs — every conversation is
simply held for you to answer manually, with a clear notice in the dashboard.

## Testing

```
node test/run.js
```

30 checks against a real running server: signup/login/session security,
trial-start-on-first-doc, malformed input handling, the full AI drafting →
verification → approval → visitor-visible flow, grounded-vs-escalated
answers, visitor/owner and cross-tenant isolation, trial expiry, and rate
limiting.

## Deploying it for a real first customer

This sandbox has no internet access, so I can't deploy it for you. To put it
online:
1. Push this folder to a small host that runs Node (Render, Railway, Fly.io
   all have simple free/cheap tiers).
2. Set `ANTHROPIC_API_KEY` as an environment variable there.
3. Set `DB_FILE` to a path on a persistent disk if the host's filesystem
   resets on redeploy (check their docs — this matters, or you'll lose data).
4. Point your ad landing page at the deployed URL's `/browse` or `/profile`
   view for Customer Support.
