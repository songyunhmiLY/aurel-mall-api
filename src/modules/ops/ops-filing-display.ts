/**
 * 公排每满 5 的倍数触发一次幸运返还。
 * 序号 5 结算序号 1，序号 10 结算序号 2。当前序号已经触发过的，下一个是再往后的那个倍数。
 */
export function nextLuckyReturn(currentSequence: number): {
  triggerSequence: number;
  beneficiarySequence: number;
} {
  const remainder = currentSequence % 5;
  const triggerSequence = remainder === 0 ? currentSequence + 5 : currentSequence + (5 - remainder);
  return { triggerSequence, beneficiarySequence: triggerSequence / 5 };
}
