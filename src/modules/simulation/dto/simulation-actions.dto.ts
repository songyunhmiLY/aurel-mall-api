import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';

const ID_PATTERN = /^\d+$/;

/** 批量注册仿真用户。只挂在已有会员下面，默认挂根账户。昵称按演练命名规则自动生成。 */
export class RegisterUsersDto {
  @IsInt()
  @Min(1)
  @Max(200)
  count!: number;

  /** 邀请人（必须是会员）。不传用根账户。 */
  @IsOptional()
  @Matches(ID_PATTERN, { message: '邀请人编号不正确' })
  inviterUserId?: string;
}

/** 红包报名演示。userIds 为空时对全部在籍会员报名；报名时间取当前仿真时刻。 */
export class RedPacketSignupDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @Matches(ID_PATTERN, { each: true, message: '用户编号不正确' })
  userIds?: string[];
}

/** 批量购买商品（创业专区或会员商城）。不指定用户时从已入座会员里随机取。 */
export class SimulatePurchaseDto {
  /** 专区。不传按创业专区。 */
  @IsOptional()
  @IsIn(['startup', 'mall'], { message: '专区不正确' })
  zone?: 'startup' | 'mall';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @Matches(ID_PATTERN, { each: true, message: '用户编号不正确' })
  userIds?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  count?: number;

  /** 不传时取该专区第一件上架商品。 */
  @IsOptional()
  @Matches(ID_PATTERN, { message: '商品编号不正确' })
  productId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  quantityMin?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  quantityMax?: number;
}

/** 任命角色。联合创始人走付费开通并产生付款记录，工作室与运营中心走管理端指定。 */
export class SimulateRoleDto {
  @Matches(ID_PATTERN, { message: '用户编号不正确' })
  userId!: string;

  @IsIn(['cofounder', 'studio', 'ops_team'], { message: '角色不正确' })
  role!: 'cofounder' | 'studio' | 'ops_team';
}

/** 时间推进。只能往后，跨日与跨月由服务按业务日逐格补齐。 */
export class AdvanceSimulationDto {
  @IsISO8601()
  to!: string;
}
