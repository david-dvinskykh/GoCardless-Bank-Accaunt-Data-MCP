import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface StoredTokens {
  /** Fingerprint of the secret pair the tokens were issued for. */
  fingerprint: string;
  access: string;
  /** Epoch milliseconds. */
  accessExpiresAt: number;
  refresh: string;
  refreshExpiresAt: number;
}

export function fingerprint(secretId: string, secretKey: string): string {
  return createHash("sha256").update(`${secretId}:${secretKey}`).digest("hex").slice(0, 16);
}

/**
 * Access tokens live 24 hours and refresh tokens 30 days. Re-issuing one on
 * every server start would burn through the token endpoint for no reason, so
 * they are cached on disk — the same reason zenmoney-mcp keeps a cache dir.
 */
export class TokenStore {
  private readonly file: string;

  constructor(cacheDir: string) {
    this.file = path.join(cacheDir, "tokens.json");
  }

  async read(expectedFingerprint: string): Promise<StoredTokens | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isStoredTokens(parsed)) return undefined;
    // Secrets rotated under us: the cached tokens belong to somebody else.
    if (parsed.fingerprint !== expectedFingerprint) return undefined;
    return parsed;
  }

  async write(tokens: StoredTokens): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(tokens), { mode: 0o600 });
    } catch {
      // A read-only cache dir costs a token request per start, nothing more.
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.file, { force: true });
    } catch {
      // Nothing to do — the in-memory token is discarded by the caller anyway.
    }
  }
}

function isStoredTokens(value: unknown): value is StoredTokens {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.fingerprint === "string" &&
    typeof candidate.access === "string" &&
    typeof candidate.accessExpiresAt === "number" &&
    typeof candidate.refresh === "string" &&
    typeof candidate.refreshExpiresAt === "number"
  );
}
