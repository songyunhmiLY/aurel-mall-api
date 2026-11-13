import { Injectable } from '@nestjs/common';
import { ClockService } from '../../common/clock/clock.service';
import { signTencentCloud, type TencentSignedRequest } from './tencent-sms.sign';

const SMS_HOST = 'sms.tencentcloudapi.com';
const SMS_SERVICE = 'sms';
const SMS_ACTION = 'SendSms';
const SMS_VERSION = '2021-01-11';

export interface SmsMessage {
  secretId: string;
  secretKey: string;
  sdkAppId: string;
  signName: string;
  region: string;
  templateId: string;
  phoneE164: string;
  params: string[];
}

export interface SmsSender {
  send(input: SmsMessage): Promise<void>;
}

@Injectable()
export class TencentSmsClient implements SmsSender {
  private http: (request: TencentSignedRequest) => Promise<unknown> = postJson;

  constructor(private readonly clock: ClockService) {}

  /** 测试替换 HTTP，避免打到腾讯云。 */
  bindHttp(http: (request: TencentSignedRequest) => Promise<unknown>): void {
    this.http = http;
  }

  async send(input: SmsMessage): Promise<void> {
    const now = await this.clock.now();
    const payload: Record<string, unknown> = {
      PhoneNumberSet: [input.phoneE164],
      SmsSdkAppId: input.sdkAppId,
      SignName: input.signName,
      TemplateId: input.templateId,
    };
    if (input.params.length > 0) {
      payload.TemplateParamSet = input.params;
    }
    const signed = signTencentCloud({
      secretId: input.secretId,
      secretKey: input.secretKey,
      service: SMS_SERVICE,
      host: SMS_HOST,
      action: SMS_ACTION,
      version: SMS_VERSION,
      region: input.region,
      timestamp: Math.floor(now.getTime() / 1000),
      payload: JSON.stringify(payload),
    });
    let parsed: unknown;
    try {
      parsed = await this.http(signed);
    } catch {
      throw new Error('腾讯云短信失败 code=network');
    }
    const code = readSmsCode(parsed);
    if (code !== 'Ok') {
      throw new Error(`腾讯云短信失败 code=${code}`);
    }
  }
}

async function postJson(request: TencentSignedRequest): Promise<unknown> {
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(8_000),
  });
  return (await response.json()) as unknown;
}

function readSmsCode(parsed: unknown): string {
  if (typeof parsed !== 'object' || parsed === null) {
    return 'network';
  }
  const response = (parsed as Record<string, unknown>).Response;
  if (typeof response !== 'object' || response === null) {
    return 'network';
  }
  const record = response as Record<string, unknown>;
  const error = record.Error;
  if (typeof error === 'object' && error !== null) {
    const code = (error as Record<string, unknown>).Code;
    return typeof code === 'string' && code.length > 0 ? code : 'error';
  }
  const statuses = record.SendStatusSet;
  if (!Array.isArray(statuses) || statuses.length === 0) {
    return 'error';
  }
  const first = statuses[0];
  if (typeof first !== 'object' || first === null) {
    return 'error';
  }
  const code = (first as Record<string, unknown>).Code;
  return typeof code === 'string' && code.length > 0 ? code : 'error';
}
