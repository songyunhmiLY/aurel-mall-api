import { createHash, createHmac } from 'node:crypto';
import { formatUtcDate } from '../../common/clock/shanghai-calendar';

const ALGORITHM = 'TC3-HMAC-SHA256';
const CONTENT_TYPE = 'application/json; charset=utf-8';

export interface TencentSignedRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/**
 * 腾讯云 API 3.0 TC3-HMAC-SHA256。
 * Date 取时间戳的 UTC 日期，不能用上海日期，否则跨日会验签失败。
 */
export function signTencentCloud(input: {
  secretId: string;
  secretKey: string;
  service: string;
  host: string;
  action: string;
  version: string;
  region: string;
  timestamp: number;
  payload: string;
}): TencentSignedRequest {
  const date = formatUtcDate(input.timestamp);
  const hashedPayload = sha256Hex(input.payload);
  const canonicalHeaders =
    `content-type:${CONTENT_TYPE}\n` +
    `host:${input.host}\n` +
    `x-tc-action:${input.action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join(
    '\n',
  );
  const credentialScope = `${date}/${input.service}/tc3_request`;
  const stringToSign = [
    ALGORITHM,
    String(input.timestamp),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const secretDate = hmac(Buffer.from(`TC3${input.secretKey}`, 'utf8'), date);
  const secretService = hmac(secretDate, input.service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign).toString('hex');
  const authorization =
    `${ALGORITHM} Credential=${input.secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    url: `https://${input.host}/`,
    body: input.payload,
    headers: {
      Authorization: authorization,
      'Content-Type': CONTENT_TYPE,
      'X-TC-Action': input.action,
      'X-TC-Timestamp': String(input.timestamp),
      'X-TC-Version': input.version,
      'X-TC-Region': input.region,
    },
  };
}

function sha256Hex(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex');
}

function hmac(key: Buffer, message: string): Buffer {
  return createHmac('sha256', key).update(message, 'utf8').digest();
}
