import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";

const PINTEREST_API = "https://api.pinterest.com/v5";
// .env is expected in the project root — same place the CLI starts from.
const ENV_FILE = resolve(process.cwd(), ".env");

/**
 * Thrown when a Pinterest API call returns 401. The adapter catches this type
 * specifically to know "try refreshing the token and retry once."
 */
export class PinterestAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinterestAuthError";
  }
}

/**
 * Exchange the refresh token for a new access token. Updates process.env and
 * persists back to .env so the next run (e.g. tomorrow's scheduled digest)
 * starts with a fresh token instead of a dead one.
 *
 * Pinterest may rotate the refresh token on this call — if so, we store the
 * new one. If not, we keep the existing one.
 *
 * Returns the new access token.
 */
export async function refreshAccessToken(): Promise<string> {
  const appId = process.env.PINTEREST_APP_ID;
  const appSecret = process.env.PINTEREST_APP_SECRET;
  const refreshToken = process.env.PINTEREST_REFRESH_TOKEN;
  if (!appId) throw new Error("PINTEREST_APP_ID not set — needed for token refresh");
  if (!appSecret) throw new Error("PINTEREST_APP_SECRET not set — needed for token refresh");
  if (!refreshToken) throw new Error("PINTEREST_REFRESH_TOKEN not set — did you run the OAuth flow?");

  const auth = Buffer.from(`${appId}:${appSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "ads:read",
  });

  const res = await fetch(`${PINTEREST_API}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Pinterest token refresh failed ${res.status}: ${errBody.slice(0, 400)}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    refresh_token_expires_in?: number;
    scope?: string;
  };

  const newAccess = data.access_token;
  const newRefresh = data.refresh_token ?? refreshToken;

  process.env.PINTEREST_ACCESS_TOKEN = newAccess;
  process.env.PINTEREST_REFRESH_TOKEN = newRefresh;

  await updateEnvFile({
    PINTEREST_ACCESS_TOKEN: newAccess,
    PINTEREST_REFRESH_TOKEN: newRefresh,
  });

  const days = Math.round(data.expires_in / 86400);
  console.error(
    `[pinterest] access token refreshed; new token valid ~${days}d (${data.expires_in}s)` +
      (data.refresh_token && data.refresh_token !== refreshToken ? "; refresh token rotated" : ""),
  );
  return newAccess;
}

/**
 * Rewrite .env in place, replacing the given keys' values while preserving
 * every other line (comments, other vars, blank lines). Atomic via temp+rename
 * so a failed write mid-flight can't truncate the file.
 */
async function updateEnvFile(updates: Record<string, string>): Promise<void> {
  const content = await readFile(ENV_FILE, "utf-8");
  const lines = content.split(/\r?\n/);
  const keysReplaced = new Set<string>();

  const rewritten = lines.map((line) => {
    for (const [key, value] of Object.entries(updates)) {
      if (keysReplaced.has(key)) continue;
      if (line.startsWith(`${key}=`)) {
        keysReplaced.add(key);
        return `${key}=${value}`;
      }
    }
    return line;
  });

  // If a key wasn't present (shouldn't happen for pre-seeded keys but be safe),
  // append it so subsequent runs can find it.
  for (const [key, value] of Object.entries(updates)) {
    if (!keysReplaced.has(key)) rewritten.push(`${key}=${value}`);
  }

  const tmp = `${ENV_FILE}.tmp`;
  await writeFile(tmp, rewritten.join("\n"), "utf-8");
  await rename(tmp, ENV_FILE);
}
