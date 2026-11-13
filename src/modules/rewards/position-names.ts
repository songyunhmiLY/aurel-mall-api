/**
 * 锁定配置里五个官方职位的显示名。
 * 编码顺序即职位从低到高：第一档是营销经理。
 * 配置若改用其他编码，显示名退回编码本身，不另造中文名。
 */
export const POSITION_NAMES: Record<string, string> = {
  marketing_manager: '营销经理',
  senior_manager: '高级经理',
  director: '营销总监',
  senior_director: '高级总监',
  chief: '首席',
};

export function positionName(code: string): string {
  return POSITION_NAMES[code] ?? code;
}
