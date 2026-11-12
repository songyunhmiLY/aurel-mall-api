import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestMerchantCertificate {
  certificatePem: string;
  privateKeyPem: string;
  bundle: string;
}

export function generateMerchantCertificate(): TestMerchantCertificate {
  const dir = mkdtempSync(join(tmpdir(), 'aurel-cert-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-nodes',
      '-subj',
      '/CN=aurel-mall-test',
    ],
    { stdio: 'ignore' },
  );
  const certificatePem = readFileSync(certPath, 'utf8');
  const privateKeyPem = readFileSync(keyPath, 'utf8');
  return { certificatePem, privateKeyPem, bundle: `${certificatePem}\n${privateKeyPem}\n` };
}
