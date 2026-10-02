import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function registrationCodeWithCa(code: string, pem: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('A complete, unexpired registration code is required');
  if (pem.length > 16384) throw new Error('Root CA certificate is too large');
  const ca = new X509Certificate(pem);
  if (!ca.ca || !ca.verify(ca.publicKey)) throw new Error('Use the relay root CA certificate, not a server certificate or private key');
  if (Date.parse(ca.validFrom) > Date.now() || Date.parse(ca.validTo) <= Date.now()) throw new Error('Root CA certificate is expired or not yet valid');
  return `dshca1_${ca.fingerprint256.replaceAll(':', '').toLowerCase()}_${code}`;
}

// This compiled file can also wrap an existing server's code without changing or restarting that server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: registration-code.js <root-ca.pem>; registration code is read from stdin');
  console.log(registrationCodeWithCa(readFileSync(0, 'utf8').trim(), readFileSync(process.argv[2], 'utf8')));
}
