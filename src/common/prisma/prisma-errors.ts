/** Prisma 错误码判定。集中一处，避免每个服务各写一份。 */
export function isPrismaErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** P2002 唯一约束冲突。 */
export function isUniqueConflict(error: unknown): boolean {
  return isPrismaErrorCode(error, 'P2002');
}

/**
 * P2002 冲突落在哪个索引上。
 * MySQL 下 Prisma 把索引名放进 meta.target，字段联合索引偶尔给字段数组，
 * 两种形态都要能读。读不到时返回空数组，调用方按“不知道”处理。
 */
export function uniqueConflictTargets(error: unknown): string[] {
  if (!isUniqueConflict(error)) {
    return [];
  }
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) {
    return target.map((item) => String(item));
  }
  if (typeof target === 'string') {
    return [target];
  }
  return [];
}

/** P2028 事务超时。 */
export function isTransactionTimeout(error: unknown): boolean {
  return isPrismaErrorCode(error, 'P2028');
}

/** P2034 事务冲突或死锁。 */
export function isTransactionConflict(error: unknown): boolean {
  return isPrismaErrorCode(error, 'P2034');
}
