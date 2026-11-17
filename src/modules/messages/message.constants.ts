/** 站内系统消息的分类。列表页按分类筛选，未知分类一律当作全部。 */

export const MESSAGE_CATEGORY_ORDER = 'order';
export const MESSAGE_CATEGORY_WALLET = 'wallet';

export const MESSAGE_CATEGORIES = [MESSAGE_CATEGORY_ORDER, MESSAGE_CATEGORY_WALLET] as const;

export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];

export function isMessageCategory(value: string): value is MessageCategory {
  return (MESSAGE_CATEGORIES as readonly string[]).includes(value);
}
