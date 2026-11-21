import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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

/** 生成演示市场树。默认 3+9+27 三层满树，先重置业务数据；每层节点数可自定义。 */
export class SeedTreeDto {
  /** 每层节点数，按层序落座。缺省 [3, 9, 27]。 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(27, { each: true })
  layers?: number[];

  /** 生成前是否先清空业务数据。默认 true。 */
  @IsOptional()
  @IsBoolean()
  reset?: boolean;

  /** 创业专区商品。不传取第一个上架商品。 */
  @IsOptional()
  @Matches(ID_PATTERN, { message: '商品编号不正确' })
  productId?: string;
}

/** 批量购买创业专区商品。不指定用户时从已注册用户里随机取。 */
export class SimulatePurchaseDto {
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

  /** 不传时取创业专区第一个上架商品。 */
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
