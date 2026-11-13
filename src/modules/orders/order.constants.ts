export const ORDER_PENDING_PAYMENT = 'pending_payment';
export const ORDER_PAID = 'paid';
export const ORDER_SHIPPED = 'shipped';
export const ORDER_CLOSED = 'closed';

export const ORDER_STATUSES = [
  ORDER_PENDING_PAYMENT,
  ORDER_PAID,
  ORDER_SHIPPED,
  ORDER_CLOSED,
] as const;

export const MAX_FEN = 2_147_483_647;
export const MAX_ORDER_LINES = 50;
export const MAX_LINE_QUANTITY = 9999;

export function addFen(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < 0 || sum > MAX_FEN) {
    throw new RangeError('amount');
  }
  return sum;
}

export function mulFen(unit: number, quantity: number): number {
  const product = unit * quantity;
  if (!Number.isSafeInteger(product) || product < 0 || product > MAX_FEN) {
    throw new RangeError('amount');
  }
  return product;
}
