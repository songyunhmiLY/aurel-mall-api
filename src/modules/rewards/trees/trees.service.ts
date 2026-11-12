import { Injectable } from '@nestjs/common';

/**
 * 邀请树与市场树占位。
 * 节点表保存 parent、depth、path，供以后用递归 SQL 查询。组树规则未实现。
 */
@Injectable()
export class TreesService {}
