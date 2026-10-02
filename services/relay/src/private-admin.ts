import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PrivateStore } from './private-store.js';
import { registrationCodeWithCa } from './registration-code.js';

process.umask(0o077);
const path = resolve(process.env.DB_PATH ?? 'data/private-relay.db');
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const store = new PrivateStore(path);
try {
  const [action, email, option, caPath, ...extra] = process.argv.slice(2);
  if (!email || extra.length || (option !== undefined && (action !== 'registration' || option !== '--ca-file' || !caPath))) throw new Error('Usage: private-admin account|registration <email> [--ca-file <root-ca.pem>]; account password is read from stdin');
  if (action === 'account') { store.provision(email, readFileSync(0, 'utf8').trim()); console.log('Account created'); }
  else if (action === 'registration') {
    const ca = caPath ? readFileSync(caPath, 'utf8') : undefined;
    if (ca !== undefined) registrationCodeWithCa('a'.repeat(43), ca);
    const code = store.registration(email);
    console.log(ca !== undefined ? registrationCodeWithCa(code, ca) : code);
  }
  else throw new Error('Unknown action');
} finally { store.db.close(); }
