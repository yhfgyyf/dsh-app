import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PrivateStore } from './private-store.js';

process.umask(0o077);
const path = resolve(process.env.DB_PATH ?? 'data/private-relay.db');
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const store = new PrivateStore(path);
try {
  const [action, email] = process.argv.slice(2);
  if (!email) throw new Error('Usage: private-admin account|registration <email>; account password is read from stdin');
  if (action === 'account') { store.provision(email, readFileSync(0, 'utf8').trim()); console.log('Account created'); }
  else if (action === 'registration') console.log(store.registration(email));
  else throw new Error('Unknown action');
} finally { store.db.close(); }
