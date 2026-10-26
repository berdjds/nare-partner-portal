import bcrypt from "bcryptjs";

/**
 * W7b: every NEW password hash is created at this cost. Hashes minted before
 * W7b (cost 10) stay valid — bcrypt.compare reads the cost from the hash —
 * and are upgraded on the owner's next successful sign-in (lib/auth.ts).
 */
export const HASH_COST = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, HASH_COST);
}

/** True when the stored hash was created below the current HASH_COST. */
export function needsRehash(hash: string): boolean {
  return bcrypt.getRounds(hash) < HASH_COST;
}
