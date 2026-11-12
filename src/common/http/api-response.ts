export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

export function isApiResponse(value: unknown): value is ApiResponse<unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.code === 'number' && typeof record.message === 'string' && 'data' in record;
}

export function toJsonSafe(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  const encoded = JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'bigint' ? inner.toString() : inner,
  );
  if (encoded === undefined) {
    return null;
  }
  return JSON.parse(encoded) as unknown;
}
