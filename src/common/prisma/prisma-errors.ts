/** Prisma 错误码判定。集中一处，避免每个服务各写一份。 */
export function isPrismaErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** P2002 唯一约束冲突。 */
export function isUniqueConflict(error: unknown): boolean {
  return isPrismaErrorCode(error, 'P2002');
}

/** P2028 事务超时。 */
export function isTransactionTimeout(error: unknown): boolean {
  return isPrismaErrorCode(error, 'P2028');
}

/** P2034 事务冲突或死锁。 */
export function isTransactionConflict(error: unknown): boolean {
  return isPrismaErrorCode(error, 'P2034');
}
