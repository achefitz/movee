import { createHash, randomInt } from 'node:crypto';
import { logger } from '../lib/logger';

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;

/** A few of the most-used passwords, so they're refused even if the breach check is unreachable. */
const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd', '12345678', '123456789', '1234567890',
  'qwertyuiop', 'qwerty123', 'iloveyou', 'abc12345', 'letmein1', 'welcome1', 'football', 'baseball',
  'sunshine', 'princess', 'starwars', 'trustno1', 'superman', 'whatever', 'computer', 'michelle',
  '11111111', '00000000', '87654321', 'asdfghjk', 'zaq12wsx', '1q2w3e4r', 'movee123', 'moviefan',
  'netflix1', 'letmein!', 'monkey12', 'dragon12', 'shadow12', 'master12', 'qwerty12', 'iloveyou1',
]);

const PWNED_URL = 'https://api.pwnedpasswords.com/range/';
const PWNED_TIMEOUT_MS = 2500;

/**
 * How often a password appears in known data breaches, via Have I Been Pwned's k-anonymity API:
 * only the first 5 hex characters of the password's SHA-1 are sent, never the password.
 * null when the service can't be reached (we don't block sign-ups on it).
 * Set PWNED_CHECK=off to skip it.
 */
export async function pwnedCount(password: string): Promise<number | null> {
  if (process.env.PWNED_CHECK === 'off') return null;
  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5), suffix = sha1.slice(5);
  try {
    const r = await fetch(PWNED_URL + prefix, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'movee-password-check' },
      signal: AbortSignal.timeout(PWNED_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    for (const line of (await r.text()).split('\n')) {
      const [s, n] = line.trim().split(':');
      if (s === suffix) return Number(n) || 0;
    }
    return 0;
  } catch (err: any) {
    logger.warn({ err: err.message }, 'breached-password check unavailable');
    return null;
  }
}

/** Why this password can't be used, or null if it's fine. */
export async function passwordProblem(password: string, username: string): Promise<string | null> {
  if (password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD) return 'That password is too long.';
  const lower = password.toLowerCase();
  const name = username.replace(/^@/, '').toLowerCase();
  if (name.length >= 3 && lower.includes(name)) return "Your password can't contain your username.";
  if (new Set(lower).size <= 2) return 'That password is too easy to guess. Try a few random words.';
  if (COMMON.has(lower)) return 'That password is too common. Try a few random words.';
  const seen = await pwnedCount(password);
  if (seen && seen > 0) {
    return `That password has shown up in data breaches${seen > 1 ? ` (${seen.toLocaleString('en-US')} times)` : ''}, so it's easy to guess. Pick another one.`;
  }
  return null;
}

// Recovery codes: 4 groups of 4 from an alphabet without look-alikes (no 0/O, 1/I/L), ~79 bits.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newRecoveryCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');
}

/** Codes are typed by hand: ignore case, spaces and dashes. */
export function normaliseRecoveryCode(raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 16 ? c.match(/.{4}/g)!.join('-') : c;
}
