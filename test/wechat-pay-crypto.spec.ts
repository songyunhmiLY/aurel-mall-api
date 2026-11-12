import {
  createCipheriv,
  createPrivateKey,
  createVerify,
  sign,
  verify,
  X509Certificate,
} from 'node:crypto';
import {
  buildAuthorizationHeader,
  decryptWechatAesGcm,
  isWechatTimestampFresh,
  maskApiV3Key,
  parseMerchantCertificateMaterial,
  signJsapiPay,
  signWechatRequest,
  verifyWechatCallbackSignature,
} from '../src/modules/payments/wechat-pay-crypto';
import { generateMerchantCertificate } from './support/test-merchant-certificate';

const API_V3_KEY = '0123456789abcdef0123456789abcdef';

describe('wechat pay crypto', () => {
  const material = generateMerchantCertificate();
  const other = generateMerchantCertificate();
  const publicKeyPem = new X509Certificate(material.certificatePem).publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();

  it('parses a merchant certificate bundle and rejects a mismatched key', () => {
    const parsed = parseMerchantCertificateMaterial(material.bundle);
    const certificate = new X509Certificate(material.certificatePem);
    expect(parsed.serialNumber).toBe(certificate.serialNumber.toUpperCase());
    expect(parsed.privateKeyPem).toContain('PRIVATE KEY');
    expect(() => parseMerchantCertificateMaterial(material.certificatePem)).toThrow(/私钥/);
    expect(() =>
      parseMerchantCertificateMaterial(`${material.certificatePem}\n${other.privateKeyPem}`),
    ).toThrow(/不匹配/);
  });

  it('round-trips an AEAD payload and masks the api v3 key', () => {
    const nonce = 'aurel-nonce-value';
    const associatedData = 'transaction';
    const plain = '{"trade_state":"SUCCESS","amount":{"total":100}}';
    const ciphertext = encrypt(API_V3_KEY, nonce, associatedData, plain);
    expect(decryptWechatAesGcm({ apiV3Key: API_V3_KEY, nonce, associatedData, ciphertext })).toBe(
      plain,
    );
    expect(() =>
      decryptWechatAesGcm({
        apiV3Key: 'ffffffffffffffffffffffffffffffff',
        nonce,
        associatedData,
        ciphertext,
      }),
    ).toThrow();
    const masked = maskApiV3Key(API_V3_KEY);
    expect(masked).toBe(`${'*'.repeat(28)}cdef`);
    expect(masked).not.toContain(API_V3_KEY);
  });

  it('signs a request and a jsapi pay invocation', () => {
    const signature = signWechatRequest({
      method: 'POST',
      urlPath: '/v3/pay/transactions/jsapi',
      timestamp: '1700000000',
      nonce: 'nonce-1',
      body: '{}',
      privateKeyPem: material.privateKeyPem,
    });
    const header = buildAuthorizationHeader({
      merchantId: '1900000109',
      serialNumber: 'ABC',
      nonce: 'nonce-1',
      timestamp: '1700000000',
      signature,
    });
    expect(header).toContain('mchid="1900000109"');
    expect(header).toContain('serial_no="ABC"');

    expect(
      verify(
        'RSA-SHA256',
        Buffer.from('POST\n/v3/pay/transactions/jsapi\n1700000000\nnonce-1\n{}\n'),
        publicKeyPem,
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(true);

    const body = '{"out_trade_no":"W1"}';
    const callbackMessage = `1700000000\nnonce-2\n${body}\n`;
    const callbackSignature = sign(
      'RSA-SHA256',
      Buffer.from(callbackMessage),
      createPrivateKey(material.privateKeyPem),
    ).toString('base64');
    expect(
      verifyWechatCallbackSignature({
        timestamp: '1700000000',
        nonce: 'nonce-2',
        body,
        signature: callbackSignature,
        publicKeyPem,
      }),
    ).toBe(true);
    expect(
      verifyWechatCallbackSignature({
        timestamp: '1700000000',
        nonce: 'nonce-2',
        body: `${body} `,
        signature: callbackSignature,
        publicKeyPem,
      }),
    ).toBe(false);

    const paySign = signJsapiPay({
      appId: 'wx-app',
      timestamp: '1700000000',
      nonce: 'nonce-3',
      prepayId: 'prepay-1',
      privateKeyPem: material.privateKeyPem,
    });
    const verifier = createVerify('RSA-SHA256');
    verifier.update('wx-app\n1700000000\nnonce-3\nprepay_id=prepay-1\n');
    verifier.end();
    expect(verifier.verify(publicKeyPem, paySign, 'base64')).toBe(true);
    expect(isWechatTimestampFresh('1700000000', new Date(1700000000 * 1000))).toBe(true);
    expect(isWechatTimestampFresh('1700000000', new Date((1700000000 + 301) * 1000))).toBe(false);
  });
});

function encrypt(apiV3Key: string, nonce: string, associatedData: string, plain: string): string {
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64');
}
