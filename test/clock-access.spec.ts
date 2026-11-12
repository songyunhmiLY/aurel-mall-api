import { isClockOverrideCallerAllowed, normalizeHost } from '../src/common/clock/clock-access';

describe('clock override caller gate', () => {
  it('allows a host that contains test, localhost, and 192.168', () => {
    expect(isClockOverrideCallerAllowed({ hostHeader: 'api.test.aurel.local' })).toBe(true);
    expect(isClockOverrideCallerAllowed({ hostHeader: 'Test.Example.com' })).toBe(true);
    expect(isClockOverrideCallerAllowed({ hostHeader: 'localhost:3000' })).toBe(true);
    expect(isClockOverrideCallerAllowed({ hostHeader: '127.0.0.1:3000' })).toBe(true);
    expect(isClockOverrideCallerAllowed({ hostHeader: '192.168.1.20:3000' })).toBe(true);
    expect(isClockOverrideCallerAllowed({ forwardedHost: 'mall.test', hostHeader: 'api' })).toBe(
      true,
    );
  });

  it('allows local socket addresses even when the host is public', () => {
    expect(
      isClockOverrideCallerAllowed({
        hostHeader: 'mall.example.com',
        remoteAddress: '::ffff:192.168.1.20',
      }),
    ).toBe(true);
    expect(
      isClockOverrideCallerAllowed({
        hostHeader: 'mall.example.com',
        remoteAddress: '::1',
      }),
    ).toBe(true);
    expect(
      isClockOverrideCallerAllowed({
        hostHeader: 'mall.example.com',
        remoteAddress: '127.0.0.1',
      }),
    ).toBe(true);
  });

  it('rejects a public host from a non-local address', () => {
    expect(
      isClockOverrideCallerAllowed({
        hostHeader: 'mall.example.com',
        remoteAddress: '172.18.0.1',
      }),
    ).toBe(false);
  });

  it('treats a hostname containing the substring test as allowed', () => {
    expect(normalizeHost('contest.example.com:3000')).toBe('contest.example.com');
    expect(isClockOverrideCallerAllowed({ hostHeader: 'contest.example.com' })).toBe(true);
  });
});
