/**
 * Shared environment helpers for the backend (Bun/Elysia).
 *
 * Provides:
 * - read/require helpers for environment variables
 * - typed helpers for DATABASE_URL and Auth config
 */

const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * Reads an environment variable and returns a non-empty string if present.
 */
export const readEnvValue = (key: string): string | undefined => {
  const v = typeof process !== "undefined" ? process.env?.[key] : undefined;
  return isNonEmpty(v) ? v : undefined;
};

/**
 * Requires an environment variable to be present and non-empty, otherwise throws.
 */
export const requireEnvValue = (key: string, errorMessage?: string): string => {
  const value = readEnvValue(key);
  if (!isNonEmpty(value)) {
    throw new Error(errorMessage ?? `Missing required env variable: ${key}`);
  }
  return value;
};

/**
 * Parses a comma/newline-separated list from an env variable into a string array.
 */
const parseList = (value?: string): string[] =>
  isNonEmpty(value)
    ? value
        .split(/[,\n]/g)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

/**
 * Returns the DATABASE_URL or throws if missing.
 */
export const getDatabaseUrl = (): string => requireEnvValue("DATABASE_URL");

/**
 * Auth-related configuration loaded from env.
 */
export interface AuthConfig {
  /**
   * Secret for auth token signing/verification.
   * BETTER_AUTH_SECRET is preferred env name.
   */
  secret?: string;
  /**
   * Public URL for the auth server (optional), eg https://api.example.com
   * BETTER_AUTH_URL or AUTH_URL
   */
  url?: string;
  /**
   * Origins allowed to call this backend (eg for CORS)
   * TRUSTED_ORIGINS or AUTH_TRUSTED_ORIGINS - comma/newline separated.
   */
  trustedOrigins: string[];
}

/**
 * Reads auth config from environment without throwing.
 */
export const readAuthConfig = (): AuthConfig => {
  const secret = readEnvValue("BETTER_AUTH_SECRET");
  const url = readEnvValue("BETTER_AUTH_URL") ?? readEnvValue("AUTH_URL");
  const trustedOrigins = parseList(
    readEnvValue("TRUSTED_ORIGINS") ?? readEnvValue("AUTH_TRUSTED_ORIGINS"),
  );

  return {
    secret,
    url,
    trustedOrigins,
  };
};

/**
 * Reads auth config and enforces required fields (currently: secret).
 */
export const requireAuthConfig = (): Required<Pick<AuthConfig, "secret">> &
  Omit<AuthConfig, "secret"> => {
  const cfg = readAuthConfig();
  if (!isNonEmpty(cfg.secret)) {
    throw new Error("Missing required env variable: BETTER_AUTH_SECRET");
  }
  return {
    secret: cfg.secret,
    url: cfg.url,
    trustedOrigins: cfg.trustedOrigins,
  };
};

/**
 * Minimal Env accessor compatible with simple DI.
 */
export type ResolvedEnv = {
  get(key: string): string | undefined;
  require(key: string, errorMessage?: string): string;
};

/**
 * Creates a simple env accessor bound to process.env.
 */
export const createEnv = (): ResolvedEnv => ({
  get: (key) => readEnvValue(key),
  require: (key, msg) => requireEnvValue(key, msg),
});
