import type { Config } from "./config.js";
import { GoCardlessApiError } from "./errors.js";
import { fingerprint, TokenStore, type StoredTokens } from "./token-store.js";

/** Renew a little before expiry so a request never races the clock. */
const EXPIRY_SKEW_MS = 60_000;

const RATE_LIMIT_HEADERS = [
  "http_x_ratelimit_limit",
  "http_x_ratelimit_remaining",
  "http_x_ratelimit_reset",
  "http_x_ratelimit_account_success_limit",
  "http_x_ratelimit_account_success_remaining",
  "http_x_ratelimit_account_success_reset",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "ratelimit-account-success-limit",
  "ratelimit-account-success-remaining",
  "ratelimit-account-success-reset",
];

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Set for the token endpoints, which must not carry an Authorization header. */
  anonymous?: boolean;
}

export interface TokenState {
  hasAccessToken: boolean;
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
}

export class GoCardlessClient {
  private readonly config: Config;
  private readonly store: TokenStore;
  private readonly fingerprint: string;
  private tokens?: StoredTokens;
  /** In-flight renewal, shared so concurrent tool calls issue one token. */
  private renewal?: Promise<StoredTokens>;

  constructor(config: Config) {
    this.config = config;
    this.store = new TokenStore(config.cacheDir);
    this.fingerprint = fingerprint(config.secretId, config.secretKey);
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const url = this.buildUrl(path, options.query);

    const send = async (token?: string): Promise<Response> => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;
      let payload: string | undefined;
      if (options.body !== undefined) {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(options.body);
      }
      return fetch(url, { method, headers, body: payload });
    };

    let response: Response;
    if (options.anonymous) {
      response = await send();
    } else {
      response = await send(await this.accessToken());
      // A token can be revoked server-side before it expires on paper.
      if (response.status === 401) {
        response = await send(await this.accessToken({ forceRenew: true }));
      }
    }

    const rateLimit = collectRateLimit(response.headers);
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const parsed = parseJson(text);

    if (!response.ok) {
      throw new GoCardlessApiError({
        status: response.status,
        method,
        path,
        body: parsed,
        rateLimit,
      });
    }
    return parsed as T;
  }

  /** Reported by the status tool; never includes the token itself. */
  async tokenState(): Promise<TokenState> {
    const tokens = this.tokens ?? (await this.store.read(this.fingerprint));
    if (!tokens) return { hasAccessToken: false };
    return {
      hasAccessToken: tokens.accessExpiresAt - EXPIRY_SKEW_MS > Date.now(),
      accessExpiresAt: new Date(tokens.accessExpiresAt).toISOString(),
      refreshExpiresAt: new Date(tokens.refreshExpiresAt).toISOString(),
    };
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(`${this.config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async accessToken(opts: { forceRenew?: boolean } = {}): Promise<string> {
    if (!opts.forceRenew) {
      const usable = await this.usableTokens();
      if (usable) return usable.access;
    } else {
      this.tokens = undefined;
      await this.store.clear();
    }
    this.renewal ??= this.renew().finally(() => {
      this.renewal = undefined;
    });
    const tokens = await this.renewal;
    return tokens.access;
  }

  private async usableTokens(): Promise<StoredTokens | undefined> {
    this.tokens ??= await this.store.read(this.fingerprint);
    if (!this.tokens) return undefined;
    return this.tokens.accessExpiresAt - EXPIRY_SKEW_MS > Date.now() ? this.tokens : undefined;
  }

  private async renew(): Promise<StoredTokens> {
    const cached = this.tokens ?? (await this.store.read(this.fingerprint));
    // A live refresh token buys a new access token without spending a new pair.
    if (cached && cached.refreshExpiresAt - EXPIRY_SKEW_MS > Date.now()) {
      try {
        const refreshed = await this.request<{ access: string; access_expires: number }>(
          "/token/refresh/",
          { method: "POST", body: { refresh: cached.refresh }, anonymous: true },
        );
        return this.persist({
          ...cached,
          access: refreshed.access,
          accessExpiresAt: Date.now() + refreshed.access_expires * 1000,
        });
      } catch (error) {
        // Refresh tokens are revoked server-side too; fall through to a new pair.
        if (!(error instanceof GoCardlessApiError) || error.status < 400 || error.status >= 500) {
          throw error;
        }
      }
    }

    const issued = await this.request<{
      access: string;
      access_expires: number;
      refresh: string;
      refresh_expires: number;
    }>("/token/new/", {
      method: "POST",
      body: { secret_id: this.config.secretId, secret_key: this.config.secretKey },
      anonymous: true,
    });

    return this.persist({
      fingerprint: this.fingerprint,
      access: issued.access,
      accessExpiresAt: Date.now() + issued.access_expires * 1000,
      refresh: issued.refresh,
      refreshExpiresAt: Date.now() + issued.refresh_expires * 1000,
    });
  }

  private async persist(tokens: StoredTokens): Promise<StoredTokens> {
    this.tokens = tokens;
    await this.store.write(tokens);
    return tokens;
  }
}

function collectRateLimit(headers: Headers): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of RATE_LIMIT_HEADERS) {
    const value = headers.get(name);
    if (value !== null) found[name] = value;
  }
  return found;
}

function parseJson(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
