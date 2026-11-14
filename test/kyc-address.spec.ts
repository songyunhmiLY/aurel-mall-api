import { BadRequestException, NotFoundException } from '@nestjs/common';
import { buildStage1 } from './support/stage1-harness';

const VALID_KYC = {
  realName: '张三',
  idNumber: '110101199003078881',
  mobile: '13800138000',
};

describe('kyc and shipping addresses', () => {
  it('stores a valid submission and rejects bad name, id number, and phone', async () => {
    const { kyc, adminUsers, users, wechat } = buildStage1();
    wechat.logins.set('code-a', { openid: 'openid-a', unionid: null });
    const session = await users.loginWithMiniProgram('code-a');
    const userId = session.user.id;

    expect(await kyc.isVerified(userId)).toBe(false);
    expect(await kyc.getForUser(userId)).toMatchObject({ verified: false, realName: null });
    await expect(kyc.submit(userId, { ...VALID_KYC, realName: '   ' })).rejects.toThrow(
      '姓名不能为空',
    );
    await expect(
      kyc.submit(userId, { ...VALID_KYC, idNumber: '11010119900307888' }),
    ).rejects.toThrow('身份证号必须是 18 位');
    await expect(
      kyc.submit(userId, { ...VALID_KYC, idNumber: '11010119900307888Y' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      kyc.submit(userId, { ...VALID_KYC, idNumber: '110101199003078882' }),
    ).rejects.toThrow('身份证号校验位不正确');
    await expect(
      kyc.submit(userId, { ...VALID_KYC, idNumber: '110101199002308881' }),
    ).rejects.toThrow('身份证号内的出生日期不正确');
    await expect(kyc.submit(userId, { ...VALID_KYC, mobile: '12345' })).rejects.toThrow(
      '手机号格式不正确',
    );
    expect(await kyc.isVerified(userId)).toBe(false);

    const saved = await kyc.submit(userId, VALID_KYC);
    expect(saved).toMatchObject({
      verified: true,
      status: 'verified',
      realName: '张三',
      idNumber: '110101199003078881',
      mobile: '13800138000',
    });
    expect(await kyc.isVerified(userId)).toBe(true);
    expect(await kyc.getForUser(userId)).toMatchObject({ idNumber: '110101199003078881' });

    const replaced = await kyc.submit(userId, { ...VALID_KYC, realName: '李四' });
    expect(replaced.realName).toBe('李四');
    expect(await adminUsers.getKyc(userId)).toMatchObject({
      verified: true,
      realName: '李四',
      idNumber: '110101199003078881',
    });
  });

  it('creates, updates, defaults, and deletes only the current user addresses', async () => {
    const { addresses } = buildStage1();
    const owner = 7n;
    const other = 8n;
    const home = await addresses.create(owner, {
      contactName: '张三',
      contactPhone: '13800138000',
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      detail: '文一路 1 号',
      isDefault: false,
    });
    const work = await addresses.create(owner, {
      contactName: '张三',
      contactPhone: '13800138001',
      province: '浙江省',
      city: '杭州市',
      district: '滨江区',
      detail: '网商路 2 号',
      isDefault: true,
    });
    expect((await addresses.list(owner)).map((item) => item.id)).toEqual([work.id, home.id]);

    const updated = await addresses.update(owner, home.id, {
      contactName: '张三丰',
      contactPhone: '13800138000',
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      detail: '文一路 9 号',
      isDefault: false,
    });
    expect(updated.detail).toBe('文一路 9 号');
    expect(updated.contactName).toBe('张三丰');

    const switched = await addresses.setDefault(owner, home.id);
    expect(switched.isDefault).toBe(true);
    const listed = await addresses.list(owner);
    expect(listed[0]?.id).toBe(home.id);
    expect(listed[0]?.isDefault).toBe(true);
    expect(listed[1]?.isDefault).toBe(false);

    await expect(addresses.update(other, home.id, updatedInput())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect((await addresses.list(owner))[0]?.detail).toBe('文一路 9 号');

    await addresses.remove(owner, work.id);
    expect((await addresses.list(owner)).map((item) => item.id)).toEqual([home.id]);
    await expect(
      addresses.create(owner, { ...updatedInput(), contactName: '  ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

function updatedInput() {
  return {
    contactName: '张三丰',
    contactPhone: '13800138000',
    province: '浙江省',
    city: '杭州市',
    district: '西湖区',
    detail: '文一路 9 号',
    isDefault: false,
  };
}
