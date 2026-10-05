/**
 * Start-up environment validation (W7a, task env-check).
 *
 * The custom server calls checkEnvironment() before it starts listening so a
 * production deployment cannot boot with a placeholder or trivially short
 * session secret: those results are fatal and the process exits non-zero
 * instead of signing JWTs with a guessable key. Outside production the same
 * problems are warnings only, so local development and CI (which often run
 * with the .env.example value) keep working.
 *
 * Pure and node-safe: no Next.js or Prisma imports, so server.ts can run it
 * before the Next app is prepared. Messages must NEVER include the secret
 * value — they are written to the deploy log verbatim.
 */

const PLACEHOLDER_MARKER = "change-me";
const MIN_SECRET_LENGTH = 16;
const RECOMMENDED_SECRET_LENGTH = 32;

export interface EnvCheckResult {
  /** Boot-blocking problems (only produced in production). */
  fatal: string[];
  /** Non-blocking problems worth fixing. */
  warnings: string[];
}

export function checkEnvironment(env: NodeJS.ProcessEnv = process.env): EnvCheckResult {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const production = env.NODE_ENV === "production";

  const secret = env.NEXTAUTH_SECRET;
  let secretProblem: string | null = null;
  if (!secret) {
    secretProblem = "NEXTAUTH_SECRET is not set";
  } else if (secret.toLowerCase().includes(PLACEHOLDER_MARKER)) {
    // Also catches the .env.example value, which embeds the marker.
    secretProblem = "NEXTAUTH_SECRET is a placeholder value";
  } else if (secret.length < MIN_SECRET_LENGTH) {
    secretProblem = `NEXTAUTH_SECRET is shorter than ${MIN_SECRET_LENGTH} characters`;
  }

  if (secretProblem) {
    if (production) {
      fatal.push(`${secretProblem}; refusing to start in production`);
    } else {
      warnings.push(`${secretProblem}; acceptable only outside production`);
    }
  } else if (secret && secret.length < RECOMMENDED_SECRET_LENGTH) {
    warnings.push(
      `NEXTAUTH_SECRET is shorter than the recommended ${RECOMMENDED_SECRET_LENGTH} characters`,
    );
  }

  if (!env.NEXTAUTH_URL) {
    warnings.push("NEXTAUTH_URL is not set; auth callbacks and Socket.io origin checks need it");
  }

  return { fatal, warnings };
}
