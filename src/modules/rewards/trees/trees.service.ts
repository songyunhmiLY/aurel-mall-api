import { Injectable } from '@nestjs/common';

/**
 * 邀请树与市场树占位。
 * 官方根账户的两行节点由 UsersService 在启动时写入。
 * 其他用户的安置算法未实现。节点表保存 parent、depth、path，供以后用递归 SQL 查询。
 */
@Injectable()
export class TreesService {}
