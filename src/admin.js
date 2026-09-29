// Usage: node src/admin.js activate you@example.com   (marks that business as a paying customer)
//        node src/admin.js list
import { db } from './db.js';
const [cmd, arg] = process.argv.slice(2);
if (cmd === 'activate' && arg) {
  const u = db.prepare('SELECT organization_id FROM users WHERE email = ?').get(arg.toLowerCase());
  if (!u) { console.log('No user with that email.'); process.exit(1); }
  db.prepare(`UPDATE organizations SET plan_status = 'active' WHERE id = ?`).run(u.organization_id);
  console.log('Activated.');
} else if (cmd === 'list') {
  for (const r of db.prepare(`SELECT o.name, o.plan_status, o.trial_started_at, u.email FROM organizations o JOIN users u ON u.organization_id = o.id`).all()) console.log(r);
} else {
  console.log('Usage: node src/admin.js activate <email> | list');
}
