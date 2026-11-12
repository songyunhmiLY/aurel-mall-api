import {
  createDecipheriv,
  createPrivateKey,
  createSign,
  sign,
  verify,
  X509Certificate,
} from 'node:crypto';

export interface MerchantCertificateMaterial {
  certificatePem: string;
  privateKeyPem: string;
  serialNumber: string;
}

export function parseMerchantCertificateMaterial(pemBundle: string): MerchantCertificateMaterial {
  const certificates = extractPemBlocks(pemBundle, 'CERTIFICATE');
  const privateKeys = [
    ...extractPemBlocks(pemBundle, 'PRIVATE KEY'),
    ...extractPemBlocks(pemBundle, 'RSA PRIVATE KEY'),
  ];
  const certificatePem = certificates[0];
  const privateKeyPem = privateKeys[0];
  if (!certificatePem || !privateKeyPem) {
    throw new Error(
      'API 证书需要同时包含商户证书和私钥（apiclient_cert.pem 与 apiclient_key.pem）',
    );
  }
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    throw new Error('API 证书无法解析');
  }
  const probe = Buffer.from('aurel-mall-wechat-cert-check');
  let signature: Buffer;
  try {
    signature = sign('sha256', probe, createPrivateKey(privateKeyPem));
  } catch {
    throw new Error('API 证书私钥无法解析');
  }
  const matches = verify('sha256', probe, certificate.publicKey, signature);
  if (!matches) {
    throw new Error('API 证书与私钥不匹配');
  }
  return {
    certificatePem,
    privateKeyPem,
    serialNumber: certificate.serialNumber.toUpperCase(),
  };
}

export function decryptWechatAesGcm(input: {
  apiV3Key: string;
  nonce: string;
  associatedData?: string;
  ciphertext: string;
}): string {
  const key = Buffer.from(input.apiV3Key, 'utf8');
  if (key.length !== 32) {
    throw new Error('APIv3 密钥长度必须是 32 字节');
  }
  const decoded = Buffer.from(input.ciphertext, 'base64');
  if (decoded.length <= 16) {
    throw new Error('微信支付密文无效');
  }
  const data = decoded.subarray(0, decoded.length - 16);
  const authTag = decoded.subarray(decoded.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(input.nonce, 'utf8'));
  decipher.setAuthTag(authTag);
  if (input.associatedData) {
    decipher.setAAD(Buffer.from(input.associatedData, 'utf8'));
  }
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function signWechatRequest(input: {
  method: string;
  urlPath: string;
  timestamp: string;
  nonce: string;
  body: string;
  privateKeyPem: string;
}): string {
  const message = `${input.method}\n${input.urlPath}\n${input.timestamp}\n${input.nonce}\n${input.body}\n`;
  return sign('RSA-SHA256', Buffer.from(message), createPrivateKey(input.privateKeyPem)).toString(
    'base64',
  );
}

export function buildAuthorizationHeader(input: {
  merchantId: string;
  serialNumber: string;
  nonce: string;
  timestamp: string;
  signature: string;
}): string {
  return `WECHATPAY2-SHA256-RSA2048 mchid="${input.merchantId}",nonce_str="${input.nonce}",signature="${input.signature}",timestamp="${input.timestamp}",serial_no="${input.serialNumber}"`;
}

export function verifyWechatCallbackSignature(input: {
  timestamp: string;
  nonce: string;
  body: string;
  signature: string;
  publicKeyPem: string;
}): boolean {
  const message = `${input.timestamp}\n${input.nonce}\n${input.body}\n`;
  return verify(
    'RSA-SHA256',
    Buffer.from(message),
    input.publicKeyPem,
    Buffer.from(input.signature, 'base64'),
  );
}

export function signJsapiPay(input: {
  appId: string;
  timestamp: string;
  nonce: string;
  prepayId: string;
  privateKeyPem: string;
}): string {
  const message = `${input.appId}\n${input.timestamp}\n${input.nonce}\nprepay_id=${input.prepayId}\n`;
  const signer = createSign('RSA-SHA256');
  signer.update(message);
  signer.end();
  return signer.sign(createPrivateKey(input.privateKeyPem)).toString('base64');
}

export function isWechatTimestampFresh(
  timestampSeconds: string,
  now: Date,
  skewSeconds = 300,
): boolean {
  if (!/^\d+$/.test(timestampSeconds)) {
    return false;
  }
  const timestamp = Number(timestampSeconds);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  return Math.abs(nowSeconds - timestamp) <= skewSeconds;
}

export function maskApiV3Key(value: string | null): string | null {
  if (!value) {
    return null;
  }
  if (value.length <= 4) {
    return '****';
  }
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

function extractPemBlocks(source: string, label: string): string[] {
  const pattern = new RegExp(`-----BEGIN ${label}-----[\\s\\S]*?-----END ${label}-----`, 'g');
  return source.match(pattern) ?? [];
}
