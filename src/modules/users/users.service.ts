import { Injectable } from '@nestjs/common';

/**
 * 用户与身份占位。
 * 登录唯一键（手机号 vs 微信 openid）尚未确认，不在此决定哪种标识可以登录。
 */
@Injectable()
export class UsersService {}
