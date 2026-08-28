import os from "node:os";
import path from "node:path";

export const DEFAULT_BASE_URL = "https://bankaccountdata.gocardless.com/api/v2";

/**
 * GoCardless refuses a requisition without a redirect URI, so one has to exist
 * even for a purely conversational flow where nobody ever lands on it. The
 * bank sends the browser there once consent is given; the account data is then
 * read through the API, not through the redirect.
 */
export const DEFAULT_REDIRECT_URI = "https://bankaccountdata.gocardless.com/";

export interface Config {
  secretId: string;
  secretKey: string;
  baseUrl: string;
  redirectUri: string;
  cacheDir: string;
}

export class ConfigError extends Error {}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConfigError(
      `${name} is not set. Create a Bank Account Data user secret at ` +
        `https://bankaccountdata.gocardless.com/ and export GOCARDLESS_SECRET_ID ` +
        `and GOCARDLESS_SECRET_KEY before starting the server.`,
    );
  }
  return value;
}

function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  const base = xdg || path.join(os.homedir() || os.tmpdir(), ".cache");
  return path.join(base, "gocardless-bank-account-data-mcp");
}

export function loadConfig(): Config {
  const baseUrl = (process.env.GOCARDLESS_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return {
    secretId: requiredEnv("GOCARDLESS_SECRET_ID"),
    secretKey: requiredEnv("GOCARDLESS_SECRET_KEY"),
    baseUrl,
    redirectUri: process.env.GOCARDLESS_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI,
    cacheDir: process.env.GOCARDLESS_CACHE_DIR?.trim() || defaultCacheDir(),
  };
}

/**
 * Configuration is read lazily: a missing secret must surface as a tool error a
 * client can read, not as a crash during stdio handshake.
 */
export function tryLoadConfig(): { config: Config } | { error: string } {
  try {
    return { config: loadConfig() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
