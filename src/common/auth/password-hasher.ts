import { argon2id, hash, verify } from 'argon2';

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, { type: argon2id });
}

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}
