import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnauthorizedException } from '@nestjs/common';
import { parse } from 'dotenv';
import type { ClockService } from '../src/common/clock/clock.service';
import { AdminTokenService } from '../src/common/auth/admin-token.service';
import { parseAppEnv } from '../src/config/app-env';
import { MutableClock } from './support/stage1-harness';

const example = parse(readFileSync(join(__dirname, '..', '.env.example')));
const env = parseAppEnv(example);

/**
 * 管理员登录态与业务时钟解耦。
 * staging 的仿真台会把业务时钟往后推几个月，如果 token 有效期跟着业务时间走，
 * 推一次就把正在操作的人踢回登录页，仿真台走不完一轮。
 */
describe('admin token lifetime', () => {
  function build() {
    const clock = new MutableClock();
    const tokens = new AdminTokenService(clock as unknown as ClockService, env);
    return { clock, tokens };
  }

  it('survives a clock override that jumps forward by a year', async () => {
    const { clock, tokens } = build();
    const issued = await tokens.issue({ id: 4n, username: 'root' });

    // 仿真台推进业务时间，系统真实时间不动。
    clock.current = new Date('2027-11-13T00:00:00.000Z');

    await expect(tokens.verify(issued.token)).resolves.toMatchObject({
      sub: 4n,
      username: 'root',
    });
  });

  it('survives a clock override that jumps backwards', async () => {
    const { clock, tokens } = build();
    const issued = await tokens.issue({ id: 4n, username: 'root' });

    clock.current = new Date('2026-01-01T00:00:00.000Z');

    await expect(tokens.verify(issued.token)).resolves.toMatchObject({ sub: 4n });
  });

  it('still expires once the real twelve hours are up', async () => {
    const { clock, tokens } = build();
    const issued = await tokens.issue({ id: 4n, username: 'root' });

    clock.realCurrent = new Date('2026-11-13T12:00:00.000Z');

    await expect(tokens.verify(issued.token)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
