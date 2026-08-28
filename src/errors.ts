/** An error carrying what the API actually said, so tool output stays diagnosable. */
export class GoCardlessApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly rateLimit: Record<string, string>;

  constructor(init: {
    status: number;
    method: string;
    path: string;
    body: unknown;
    rateLimit: Record<string, string>;
  }) {
    super(`${init.method} ${init.path} failed with HTTP ${init.status}: ${describe(init.body)}`);
    this.name = "GoCardlessApiError";
    this.status = init.status;
    this.method = init.method;
    this.path = init.path;
    this.body = init.body;
    this.rateLimit = init.rateLimit;
  }

  /** Account endpoints are capped per account per day; 429 means the cap is spent. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  toToolMessage(): string {
    const parts = [this.message];
    if (this.isRateLimited) {
      const reset = this.rateLimit["ratelimit-account-success-reset"] ?? this.rateLimit["ratelimit-reset"];
      parts.push(
        "GoCardless caps how often each account endpoint may be called per account per day." +
          (reset ? ` The limit resets in ${reset} seconds.` : ""),
      );
    }
    if (this.status === 401) {
      parts.push("The access token was rejected. Check GOCARDLESS_SECRET_ID and GOCARDLESS_SECRET_KEY.");
    }
    return parts.join(" ");
  }
}

function describe(body: unknown): string {
  if (body === undefined || body === null || body === "") return "(empty response body)";
  if (typeof body === "string") return body.slice(0, 2000);
  try {
    return JSON.stringify(body).slice(0, 2000);
  } catch {
    return String(body);
  }
}
