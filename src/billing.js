import { db } from './db.js';

export function trialDays() {
  const n = Number(process.env.TRIAL_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

export function getOrg(organizationId) {
  return db.prepare('SELECT * FROM organizations WHERE id = ?').get(organizationId);
}

/**
 * Trial clock starts when the business adds its first piece of information (not at sign-up),
 * so people aren't charged for days spent just setting up.
 */
export function getAccess(org) {
  if (org.plan_status === 'active') return { allowed: true, state: 'active', endsAt: null };
  if (!org.trial_started_at) return { allowed: true, state: 'trial_not_started', endsAt: null };
  const endsAt = new Date(Date.parse(org.trial_started_at) + trialDays() * 86400000).toISOString();
  if (Date.now() < Date.parse(endsAt)) return { allowed: true, state: 'trial', endsAt };
  return { allowed: false, state: 'expired', endsAt };
}
