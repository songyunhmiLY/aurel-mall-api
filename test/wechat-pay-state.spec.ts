import { nextPaymentStatus } from '../src/modules/payments/wechat-pay-state';

describe('wechat payment state', () => {
  it('moves a pending payment to success or failed', () => {
    expect(nextPaymentStatus('pending', 'SUCCESS')).toBe('success');
    expect(nextPaymentStatus('pending', 'PAYERROR')).toBe('failed');
    expect(nextPaymentStatus('pending', 'CLOSED')).toBe('failed');
    expect(nextPaymentStatus('pending', 'REVOKED')).toBe('failed');
    expect(nextPaymentStatus('pending', 'NOTPAY')).toBe('pending');
    expect(nextPaymentStatus('pending', 'USERPAYING')).toBe('pending');
    expect(nextPaymentStatus('pending', 'REFUND')).toBe('pending');
  });

  it('keeps success terminal and lets a later SUCCESS recover a failed payment', () => {
    expect(nextPaymentStatus('success', 'PAYERROR')).toBe('success');
    expect(nextPaymentStatus('success', 'CLOSED')).toBe('success');
    expect(nextPaymentStatus('failed', 'SUCCESS')).toBe('success');
    expect(nextPaymentStatus('failed', 'CLOSED')).toBe('failed');
  });
});
