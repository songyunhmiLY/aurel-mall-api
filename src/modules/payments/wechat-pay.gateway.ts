import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ClockService } from '../../common/clock/clock.service';
import {
  buildAuthorizationHeader,
  decryptWechatAesGcm,
  isWechatTimestampFresh,
  signWechatRequest,
  verifyWechatCallbackSignature,
} from './wechat-pay-crypto';
import type { WechatPayCredentials } from './wechat-pay-settings.service';

const WECHAT_API_ORIGIN = 'https://api.mch.weixin.qq.com';
const JSAPI_PATH = '/v3/pay/transactions/jsapi';
const CERTIFICATES_PATH = '/v3/certificates';

export interface JsapiPrepayInput {
  merchantId: string;
  privateKeyPem: string;
  certificateSerial: string;
  appId: string;
  description: string;
  outTradeNo: string;
  notifyUrl: string;
  amountFen: number;
  openid: string;
}

export interface WechatNotifyHeaders {
  timestamp: string;
  nonce: string;
  signature: string;
  serial: string;
}

export interface VerifiedWechatTrade {
  outTradeNo: string;
  transactionId: string;
  tradeState: string;
  mchId: string;
  amountFen: number;
}

interface CachedPlatformCert {
  pem: string;
  expireAtMs: number;
}

@Injectable()
export class WechatPayGateway {
  private readonly logger = new Logger(WechatPayGateway.name);
  private platformCerts = new Map<string, CachedPlatformCert>();

  constructor(private readonly clock: ClockService) {}

  async createJsapiTransaction(input: JsapiPrepayInput): Promise<{ prepayId: string }> {
    const body = JSON.stringify({
      appid: input.appId,
      mchid: input.merchantId,
      description: input.description,
      out_trade_no: input.outTradeNo,
      notify_url: input.notifyUrl,
      amount: { total: input.amountFen, currency: 'CNY' },
      payer: { openid: input.openid },
    });
    const response = await this.signedFetch('POST', JSAPI_PATH, body, input);
    const payload = await readJson(response);
    if (!response.ok) {
      const code =
        typeof payload.code === 'string' ? payload.code : 'HTTP_' + String(response.status);
      this.logger.warn(`wechat jsapi prepay failed: ${code}`);
      throw new BadGatewayException(wechatErrorMessage(payload));
    }
    const prepayId = typeof payload.prepay_id === 'string' ? payload.prepay_id : '';
    if (!prepayId) {
      throw new BadGatewayException('微信支付未返回 prepay_id');
    }
    return { prepayId };
  }

  async createDomesticRefund(input: {
    merchantId: string;
    privateKeyPem: string;
    certificateSerial: string;
    outTradeNo: string;
    outRefundNo: string;
    refundFen: number;
    totalFen: number;
  }): Promise<{ refundId: string; status: string }> {
    const body = JSON.stringify({
      out_trade_no: input.outTradeNo,
      out_refund_no: input.outRefundNo,
      amount: { refund: input.refundFen, total: input.totalFen, currency: 'CNY' },
    });
    const response = await this.signedFetch('POST', '/v3/refund/domestic/refunds', body, input);
    const payload = await readJson(response);
    if (!response.ok) {
      const code =
        typeof payload.code === 'string' ? payload.code : 'HTTP_' + String(response.status);
      this.logger.warn(`wechat refund failed: ${code}`);
      throw new BadGatewayException(wechatErrorMessage(payload));
    }
    const status = typeof payload.status === 'string' ? payload.status : '';
    const refundId = typeof payload.refund_id === 'string' ? payload.refund_id : '';
    if (status !== 'SUCCESS' && status !== 'PROCESSING') {
      throw new BadGatewayException('微信退款未受理');
    }
    return { refundId, status };
  }

  async verifyAndDecrypt(
    credentials: WechatPayCredentials,
    rawBody: string,
    headers: WechatNotifyHeaders,
  ): Promise<VerifiedWechatTrade> {
    if (!headers.timestamp || !headers.nonce || !headers.signature || !headers.serial) {
      throw new UnauthorizedException('微信支付回调缺少签名头');
    }
    const now = await this.clock.now();
    if (!isWechatTimestampFresh(headers.timestamp, now)) {
      throw new UnauthorizedException('微信支付回调时间戳无效');
    }
    const publicKeyPem = await this.platformCertificatePem(headers.serial, credentials);
    const valid = verifyWechatCallbackSignature({
      timestamp: headers.timestamp,
      nonce: headers.nonce,
      body: rawBody,
      signature: headers.signature,
      publicKeyPem,
    });
    if (!valid) {
      throw new UnauthorizedException('微信支付回调签名无效');
    }
    const resource = readNotifyResource(rawBody);
    let plain: string;
    try {
      plain = decryptWechatAesGcm({
        apiV3Key: credentials.apiV3Key,
        nonce: resource.nonce,
        associatedData: resource.associatedData,
        ciphertext: resource.ciphertext,
      });
    } catch {
      throw new BadRequestException('微信支付回调报文无法解密');
    }
    return readTrade(plain);
  }

  private async platformCertificatePem(
    serial: string,
    credentials: WechatPayCredentials,
  ): Promise<string> {
    const normalized = serial.toUpperCase();
    const now = await this.clock.now();
    const cached = this.platformCerts.get(normalized);
    if (cached && cached.expireAtMs > now.getTime()) {
      return cached.pem;
    }
    await this.refreshPlatformCertificates(credentials);
    const loaded = this.platformCerts.get(normalized);
    if (!loaded) {
      throw new UnauthorizedException('找不到对应的微信支付平台证书');
    }
    return loaded.pem;
  }

  private async refreshPlatformCertificates(credentials: WechatPayCredentials): Promise<void> {
    const response = await this.signedFetch('GET', CERTIFICATES_PATH, '', {
      merchantId: credentials.merchantId,
      privateKeyPem: credentials.privateKeyPem,
      certificateSerial: credentials.serialNumber,
    });
    const payload = await readJson(response);
    if (!response.ok) {
      this.logger.warn('wechat platform certificate download failed');
      throw new BadGatewayException(wechatErrorMessage(payload));
    }
    const entries = Array.isArray(payload.data) ? payload.data : [];
    const next = new Map<string, CachedPlatformCert>();
    const now = await this.clock.now();
    for (const entry of entries) {
      const parsed = readPlatformCertificate(entry, credentials.apiV3Key, now.getTime());
      if (parsed) {
        next.set(parsed.serial, { pem: parsed.pem, expireAtMs: parsed.expireAtMs });
      }
    }
    if (next.size === 0) {
      throw new BadGatewayException('无法下载微信支付平台证书');
    }
    this.platformCerts = next;
  }

  private async signedFetch(
    method: string,
    path: string,
    body: string,
    credentials: { merchantId: string; privateKeyPem: string; certificateSerial: string },
  ): Promise<Response> {
    const now = await this.clock.now();
    const timestamp = Math.floor(now.getTime() / 1000).toString();
    const nonce = randomBytes(16).toString('hex');
    const signature = signWechatRequest({
      method,
      urlPath: path,
      timestamp,
      nonce,
      body,
      privateKeyPem: credentials.privateKeyPem,
    });
    const authorization = buildAuthorizationHeader({
      merchantId: credentials.merchantId,
      serialNumber: credentials.certificateSerial,
      nonce,
      timestamp,
      signature,
    });
    try {
      return await fetch(`${WECHAT_API_ORIGIN}${path}`, {
        method,
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'aurel-mall-api',
        },
        body: method === 'GET' ? undefined : body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      this.logger.warn(`wechat request failed: ${method} ${path}`);
      throw new BadGatewayException('微信支付请求失败');
    }
  }
}

function readNotifyResource(rawBody: string): {
  nonce: string;
  associatedData: string;
  ciphertext: string;
} {
  const parsed = parseObject(rawBody, '微信支付回调不是合法 JSON');
  const resource = parsed.resource;
  if (typeof resource !== 'object' || resource === null) {
    throw new BadRequestException('微信支付回调格式无效');
  }
  const record = resource as Record<string, unknown>;
  if (record.algorithm !== undefined && record.algorithm !== 'AEAD_AES_256_GCM') {
    throw new BadRequestException('不支持的微信支付加密算法');
  }
  const nonce = readString(record.nonce);
  const ciphertext = readString(record.ciphertext);
  const associatedData = readString(record.associated_data) ?? '';
  if (!nonce || !ciphertext) {
    throw new BadRequestException('微信支付回调缺少密文');
  }
  return { nonce, associatedData, ciphertext };
}

function readTrade(plain: string): VerifiedWechatTrade {
  const parsed = parseObject(plain, '微信支付回调明文不是合法 JSON');
  const outTradeNo = readString(parsed.out_trade_no);
  const transactionId = readString(parsed.transaction_id) ?? '';
  const tradeState = readString(parsed.trade_state);
  const mchId = readString(parsed.mchid);
  const amount = parsed.amount;
  const total =
    typeof amount === 'object' && amount !== null
      ? (amount as { total?: unknown }).total
      : undefined;
  if (
    !outTradeNo ||
    !tradeState ||
    !mchId ||
    typeof total !== 'number' ||
    !Number.isInteger(total)
  ) {
    throw new BadRequestException('微信支付回调缺少必要字段');
  }
  return { outTradeNo, transactionId, tradeState, mchId, amountFen: total };
}

function readPlatformCertificate(
  entry: unknown,
  apiV3Key: string,
  nowMs: number,
): { serial: string; pem: string; expireAtMs: number } | null {
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const serial = readString(record.serial_no);
  const encrypted = record.encrypt_certificate;
  if (!serial || typeof encrypted !== 'object' || encrypted === null) {
    return null;
  }
  const cipher = encrypted as Record<string, unknown>;
  const nonce = readString(cipher.nonce);
  const ciphertext = readString(cipher.ciphertext);
  if (!nonce || !ciphertext) {
    return null;
  }
  const associatedData = readString(cipher.associated_data) ?? '';
  let pem: string;
  try {
    pem = decryptWechatAesGcm({ apiV3Key, nonce, associatedData, ciphertext });
  } catch {
    return null;
  }
  const expireRaw = readString(record.expire_time);
  const expireAtMs = expireRaw ? Date.parse(expireRaw) : nowMs + 5 * 60 * 1000;
  return {
    serial: serial.toUpperCase(),
    pem,
    expireAtMs: Number.isNaN(expireAtMs) ? nowMs : expireAtMs,
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function parseObject(raw: string, invalidMessage: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException(invalidMessage);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BadRequestException(invalidMessage);
  }
  return parsed as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function wechatErrorMessage(payload: Record<string, unknown>): string {
  const message = typeof payload.message === 'string' ? payload.message : '微信支付请求失败';
  return message.slice(0, 200);
}
