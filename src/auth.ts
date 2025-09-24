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

const createPool = (databaseUrl: string) => {
  // Robust SSL selection:
  // - Respect explicit ssl/sslmode query params
  // - Disable SSL for localhost/127.0.0.1 by default
  // - Enable relaxed TLS for hosted DBs by default
  let ssl: boolean | { rejectUnauthorized: boolean } | undefined;

  try {
    const u = new URL(databaseUrl);
    const host = (u.hostname || "").toLowerCase();
    const params = u.searchParams;
    const sslParam = params.get("ssl");
    const sslmode = params.get("sslmode");

    if (sslmode) {
      // Common values: disable, allow, prefer, require, verify-ca, verify-full
      if (/^disable$/i.test(sslmode)) {
        ssl = false;
      } else {
        // Use relaxed TLS to support most hosted providers without CA bundles
        ssl = { rejectUnauthorized: false };
      }
    } else if (sslParam) {
      if (sslParam === "0" || /^false$/i.test(sslParam)) {
        ssl = false;
      } else {
        ssl = { rejectUnauthorized: false };
      }
    } else {
      const isLocal =
        host === "localhost" || host === "127.0.0.1" || host.endsWith(".local");
      ssl = isLocal ? false : { rejectUnauthorized: false };
    }
  } catch {
    // If URL parsing fails, default to relaxed TLS for safety on hosted DBs
    ssl = { rejectUnauthorized: false };
  }

  return new Pool({
    connectionString: databaseUrl,
    ssl,
  });
};

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
    // Prod
    "https://app.diaryx.net",
    "https://app.diaryx.org",
    "https://*adammharris-projects.vercel.app",
    // Dev
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4321",
    "http://127.0.0.1:4321",
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
      advanced: {
        defaultCookieAttributes: (() => {
          const isProd =
            process.env.NODE_ENV === "production" ||
            process.env.NODE_ENV === "staging";
          if (!isProd) {
            return { sameSite: "lax", secure: false, partitioned: false };
          }
          let domain: string | undefined;
          try {
            const cfg = readAuthConfig();
            if (cfg?.url) {
              const u = new URL(cfg.url);
              const h = u.hostname.toLowerCase();
              if (h !== "localhost" && !/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
                domain = "." + h.replace(/^\./, "");
              }
            }
          } catch {}
          return {
            sameSite: "none",
            secure: true,
            partitioned: true,
            ...(domain ? { domain } : {}),
          };
        })(),
        cookies: {
          sessionToken: {
            attributes: (() => {
              const isProd =
                process.env.NODE_ENV === "production" ||
                process.env.NODE_ENV === "staging";
              if (!isProd) {
                return {
                  sameSite: "lax",
                  secure: false,
                  partitioned: false,
                };
              }
              let domain: string | undefined;
              try {
                const cfg = readAuthConfig();
                if (cfg?.url) {
                  const u = new URL(cfg.url);
                  const h = u.hostname.toLowerCase();
                  if (h !== "localhost" && !/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
                    domain = "." + h.replace(/^\./, "");
                  }
                }
              } catch {}
              return {
                sameSite: "none",
                secure: true,
                partitioned: true,
                ...(domain ? { domain } : {}),
              };
            })(),
          },
        },
      },
      plugins: [openAPI()],
    });
    authCache.set(cacheKey, auth);
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
