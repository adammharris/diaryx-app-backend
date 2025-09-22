import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { openAPI } from "better-auth/plugins";

import { getDatabaseUrl, readAuthConfig } from "./env";

/**
 * Neon Pool + Better Auth helpers for the backend (Bun/Elysia).
 *
 * - getDbPool(): returns a cached Neon Pool using DATABASE_URL
 * - getAuth(): returns a cached Better Auth instance using Neon Pool
 * - getSessionFromRequest(req): convenience to read the session for a request
 */

const poolCache = new Map<string, Pool>();
const authCache = new Map<string, ReturnType<typeof betterAuth>>();

const createAuthStub = (message: string): ReturnType<typeof betterAuth> =>
  ({
    handler: async () => {
      throw new Error(message);
    },
    api: {
      async getSession() {
        throw new Error(message);
      },
    },
  }) as unknown as ReturnType<typeof betterAuth>;

const createPool = (databaseUrl: string) =>
  new Pool({
    connectionString: databaseUrl,
    // If sslmode isn't explicitly provided, default to TLS with relaxed cert to support most hosts.
    ssl: databaseUrl.includes("sslmode=")
      ? undefined
      : { rejectUnauthorized: false },
  });

/**
 * Returns a cached Neon connection pool for DATABASE_URL.
 */
export const getDbPool = (): Pool => {
  const databaseUrl = getDatabaseUrl();
  let pool = poolCache.get(databaseUrl);
  if (!pool) {
    pool = createPool(databaseUrl);
    poolCache.set(databaseUrl, pool);
  }
  return pool;
};

/**
 * Returns a cached Better Auth instance wired to Neon pool.
 * If BETTER_AUTH_SECRET is missing, returns a stub that throws with a clear message.
 */
export const getAuth = (): ReturnType<typeof betterAuth> => {
  const databaseUrl = getDatabaseUrl();
  const { secret, trustedOrigins } = readAuthConfig();

  if (!secret) {
    return createAuthStub(
      "BETTER_AUTH_SECRET environment variable is required for auth",
    );
  }

  // Merge trusted origins from env with safe defaults (backend hosted on api.diaryx.net)
  const defaultOrigins = [
    "https://app.diaryx.net",
    "https://*adammharris-projects.vercel.app",
  ];
  const mergedOrigins = Array.from(
    new Set([...(trustedOrigins ?? []), ...defaultOrigins]),
  );

  const cacheKey = `${databaseUrl}::${secret}`;
  let auth = authCache.get(cacheKey);
  if (!auth) {
    const pool = getDbPool();
    auth = betterAuth({
      database: pool,
      emailAndPassword: {
        enabled: true,
      },
      secret,
      trustedOrigins: mergedOrigins,
    });
    authCache.set(cacheKey, auth);
    plugins: [openAPI()];
  }
  return auth;
};

/**
 * Attempts to resolve the Better Auth session for the given request.
 * Returns null if no valid session is present.
 */
export const getSessionFromRequest = async <TSession = unknown>(
  request: Request,
): Promise<TSession | null> => {
  const auth = getAuth();
  const session = await auth.api.getSession({
    headers: request.headers,
    asResponse: false,
  });
  return (session as TSession) ?? null;
};

export type AuthInstance = ReturnType<typeof betterAuth>;

/**
 * Gracefully close all connection pools (useful for dev restarts and shutdown).
 */
export const closeAllDbPools = async (): Promise<void> => {
  const pools = Array.from(poolCache.values());
  await Promise.allSettled(pools.map((p) => p.end()));
  poolCache.clear();
};
