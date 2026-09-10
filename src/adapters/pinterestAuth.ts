import { assertWritable, daysUntil, recordExpiry, updateEnvFile } from "./tokenStore.js";

const PINTEREST_API = "https://api.pinterest.com/v5";

/** Renew this many days before expiry rather than waiting for a 401. */
const RENEW_WHEN_DAYS_LEFT = 7;

/** Every scope the digest needs. Reporting needs ads:read; creative thumbnails
 *  (GET /pins/{id}) need pins:read + boards:read. */
export const REQUIRED_SCOPES = ["ads:read", "pins:read", "boards:read", "user_accounts:read"];

/**
 * Thrown when a Pinterest API call returns 401. The adapter catches this type
 * specifically to know "try refreshing the token and retry once."
 *
 * Careful: Pinterest returns 401 for TWO different problems — an expired or
 * revoked token (refreshing fixes it) and a token that is missing the scope
 * for that endpoint (refreshing does NOT fix it; only a re-auth does). Use
 * isScopeError() to tell them apart before refreshing.
 */
export class PinterestAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinterestAuthError";
  }
}

/**
 * True when a 401 is Pinterest saying "this token lacks the required scopes"
 * rather than "this token is dead". Their body looks like:
 *   {"code":3,"message":"Your token does not have sufficient permissions ...
 *    Missing: ['boards:read', 'pins:read']"}
 * Refreshing on this would burn a token rotation and fail exactly the same way.
 */
export function isScopeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /sufficient permissions|Missing: \[/i.test(message);
}

/**
 * Exchange the refresh token for a new access token. Updates process.env and
 * persists back to .env so the next run starts with a fresh token.
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

  // Before the exchange, not after: Pinterest can rotate the refresh token, and
  // a token we can't write down is a token we've lost.
  assertWritable("refresh the Pinterest token");

  const auth = Buffer.from(`${appId}:${appSecret}`).toString("base64");
  // Deliberately no `scope` parameter. Per OAuth (RFC 6749 §6) a refresh with no
  // scope returns the original scopes of the grant; passing one NARROWS the new
  // token to it. This used to send `scope: "ads:read"`, which silently threw
  // away the pins:read/boards:read/user_accounts:read scopes granted in the
  // April 2026 re-auth on the first refresh after it — the ads reporting pull
  // kept working while every GET /pins/{id} started returning 401.
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
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
  await recordExpiry("PINTEREST_TOKEN_EXPIRES_AT", data.expires_in);
  if (data.refresh_token_expires_in) {
    await recordExpiry("PINTEREST_REFRESH_EXPIRES_AT", data.refresh_token_expires_in);
  }

  const days = Math.round(data.expires_in / 86400);
  // Log the granted scopes: if they ever narrow again, this line is the evidence.
  console.error(
    `[pinterest] access token refreshed; new token valid ~${days}d (${data.expires_in}s)` +
      (data.refresh_token && data.refresh_token !== refreshToken ? "; refresh token rotated" : "") +
      `; scopes: ${data.scope ?? "(not reported)"}`,
  );

  const granted = (data.scope ?? "").split(/[,\s]+/).filter(Boolean);
  if (granted.length > 0) {
    const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s));
    if (missing.length > 0) {
      console.error(
        `[pinterest] WARNING: refreshed token is missing ${missing.join(", ")} — ` +
          `thumbnails will not render. The refresh_token's grant no longer covers ` +
          `these; a full re-auth is needed (see TOKEN_ROTATION.md).`,
      );
    }
  }
  return newAccess;
}

/**
 * Renew ahead of expiry. Returns what happened so the CLI can report it.
 * Reactive 401 refresh still exists as the safety net; this is what keeps the
 * digest from ever hitting one.
 */
export async function ensureFreshToken(): Promise<
  { renewed: boolean; reason: string; daysLeft?: number }
> {
  const left = daysUntil(process.env.PINTEREST_TOKEN_EXPIRES_AT);
  if (left !== undefined && left > RENEW_WHEN_DAYS_LEFT) {
    return { renewed: false, reason: `${left.toFixed(1)}d left`, daysLeft: left };
  }
  // Unknown expiry (first run after this change) renews once to establish it.
  const why = left === undefined ? "expiry unknown" : `${left.toFixed(1)}d left`;
  await refreshAccessToken();
  const after = daysUntil(process.env.PINTEREST_TOKEN_EXPIRES_AT);
  return { renewed: true, reason: why, daysLeft: after };
}

const DEFAULT_REDIRECT_URI = "https://localhost/";

/** The authorize URL for a full re-auth, with every scope the digest needs.
 *  Built here so nobody has to hand-assemble it (and forget a scope again). */
export function buildAuthorizeUrl(): string {
  const appId = process.env.PINTEREST_APP_ID;
  if (!appId) throw new Error("PINTEREST_APP_ID not set");
  const redirectUri = process.env.PINTEREST_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
  const url = new URL("https://www.pinterest.com/oauth/");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", REQUIRED_SCOPES.join(","));
  url.searchParams.set("state", "natal");
  return url.toString();
}

/**
 * Exchange an OAuth authorization code for a fresh access + refresh token pair.
 * This is the ONE manual step Pinterest needs, and only when the grant itself
 * has to be rebuilt (e.g. a scope was lost, or the refresh token died).
 */
export async function exchangeAuthCode(code: string): Promise<void> {
  const appId = process.env.PINTEREST_APP_ID;
  const appSecret = process.env.PINTEREST_APP_SECRET;
  if (!appId) throw new Error("PINTEREST_APP_ID not set");
  if (!appSecret) throw new Error("PINTEREST_APP_SECRET not set");
  const redirectUri = process.env.PINTEREST_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;

  assertWritable("seed the Pinterest token");

  const auth = Buffer.from(`${appId}:${appSecret}`).toString("base64");
  const res = await fetch(`${PINTEREST_API}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Pinterest code exchange failed ${res.status}: ${body.slice(0, 400)}` +
        ` (auth codes are single-use and expire fast — grab a fresh one if this repeats)`,
    );
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    refresh_token_expires_in?: number;
    scope?: string;
  };

  process.env.PINTEREST_ACCESS_TOKEN = data.access_token;
  process.env.PINTEREST_REFRESH_TOKEN = data.refresh_token;
  await updateEnvFile({
    PINTEREST_ACCESS_TOKEN: data.access_token,
    PINTEREST_REFRESH_TOKEN: data.refresh_token,
  });
  await recordExpiry("PINTEREST_TOKEN_EXPIRES_AT", data.expires_in);
  if (data.refresh_token_expires_in) {
    await recordExpiry("PINTEREST_REFRESH_EXPIRES_AT", data.refresh_token_expires_in);
  }

  const granted = (data.scope ?? "").split(/[,\s]+/).filter(Boolean);
  const missing = REQUIRED_SCOPES.filter((sc) => !granted.includes(sc));
  console.error(`[pinterest] re-auth complete; scopes: ${granted.join(", ") || "(not reported)"}`);
  if (missing.length > 0) {
    console.error(
      `[pinterest] WARNING: still missing ${missing.join(", ")} — re-run the authorize URL ` +
        `and make sure every scope checkbox is approved.`,
    );
  }
}
