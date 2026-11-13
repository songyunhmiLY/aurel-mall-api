import { AsyncLocalStorage } from 'node:async_hooks';
import type { NotifyIntent } from './notify-intent';

type Flusher = (intents: readonly NotifyIntent[]) => Promise<void>;

const storage = new AsyncLocalStorage<NotifyIntent[]>();

let currentFlusher: Flusher = async () => {};

export function setNotifyFlusher(next: Flusher): void {
  currentFlusher = next;
}

export function resetNotifyFlusher(): void {
  currentFlusher = async () => {};
}

/**
 * 只在事务回调里入队。事务成功提交后才发送。
 * 回调外面调用会被丢掉，避免在尚未提交时发出去。
 */
export function enqueueNotify(intent: NotifyIntent): void {
  const buffer = storage.getStore();
  if (!buffer) {
    return;
  }
  buffer.push(intent);
}

/**
 * 包住一次交互式事务。回调抛错时不发送。
 * 发送失败只记日志，不能让已经提交的业务再失败。
 */
export async function runNotifyTransaction<T>(
  work: () => Promise<T>,
  flush: Flusher = currentFlusher,
): Promise<T> {
  const buffer: NotifyIntent[] = [];
  const result = await storage.run(buffer, work);
  if (buffer.length === 0) {
    return result;
  }
  try {
    await flush(buffer);
  } catch {
    // 业务事务已经提交。通知失败不能再抛出去。
  }
  return result;
}

/** 数组事务没有回调，不包通知。交互式事务在提交成功后发送。 */
export function wrapTransaction(
  original: (fn: unknown, options?: unknown) => Promise<unknown>,
): (fn: unknown, options?: unknown) => Promise<unknown> {
  return (fn, options) => {
    if (typeof fn !== 'function') {
      return original(fn, options);
    }
    return runNotifyTransaction(() => original(fn, options));
  };
}
