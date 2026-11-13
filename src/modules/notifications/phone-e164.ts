/**
 * 腾讯云短信要 E.164。
 * 已经带 + 的号码原样使用。微信手机号组件在大陆返回的 11 位号码补 +86。
 * 其他格式无法判断国家，不发送短信。
 */
export function toE164(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim().replace(/[\s-]/g, '');
  if (trimmed.length === 0) {
    return null;
  }
  if (/^\+\d{8,15}$/.test(trimmed)) {
    return trimmed;
  }
  if (/^1\d{10}$/.test(trimmed)) {
    return `+86${trimmed}`;
  }
  return null;
}
