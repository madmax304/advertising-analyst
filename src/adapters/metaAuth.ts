import { assertWritable, daysUntil, recordExpiry, updateEnvFile } from "./tokenStore.js";

const GRAPH = "https://graph.facebook.com/v20.0";

/** Meta long-lived user tokens last ~60d. Roll with plenty of head-room so a
 *  few missed scheduled runs can't strand us. */
const RENEW_WHEN_DAYS_LEFT = 14;

export class MetaAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaAuthError";
  }
}

/** Meta signals a dead/invalid token with OAuthException / code 190. */
export function isAuthError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /OAuthException|"code"\s*:\s*190|Session has expired/i.test(m);
}

type DebugToken = {
  is_valid: boolean;
  expires_at?: number; // unix seconds; 0 means "never"
  scopes?: string[];
  application?: string;
};

/**
 * Ask Meta about a token instead of guessing: validity, expiry and scopes.
 * Uses the app token (APP_ID|APP_SECRET) so it works even on a dead user token.
 */
export async function inspectToken(token?: string): Promise<DebugToken> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const input = token ?? process.env.META_ACCESS_TOKEN;
  if (!appId || !appSecret) throw new Error("META_APP_ID / META_APP_SECRET not set");
  if (!input) throw new Error("META_ACCESS_TOKEN not set");

  const url = new URL(`${GRAPH}/debug_token`);
  url.searchParams.set("input_token", input);
  url.searchParams.set("access_token", `${appId}|${appSecret}`);

  const res = await fetch(url);
  const body = (await res.json()) as { data?: DebugToken; error?: { message: string } };
  if (!res.ok || body.error) {
    throw new MetaAuthError(`Meta debug_token failed: ${body.error?.message ?? res.status}`);
  }
  return body.data ?? { is_valid: false };
}

/**
 * Exchange the current long-lived token for a fresh one.
 *
 * Meta has no refresh_token. The documented way to keep a user token alive is
 * to re-exchange a still-VALID long-lived token via fb_exchange_token, which
 * returns one dated ~60d out. Two consequences worth knowing:
 *   - It cannot resurrect an already-expired token. Once it lapses, only a
 *     manual Graph Explorer re-auth gets you back (see TOKEN_ROTATION.md).
 *   - Meta does not always extend; it can hand back the same expiry. We log
 *     before/after so that's visible rather than assumed.
 * The permanent fix is a System User token, which never expires.
 */
export async function rollLongLivedToken(): Promise<string> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const current = process.env.META_ACCESS_TOKEN;
  if (!appId) throw new Error("META_APP_ID not set");
  if (!appSecret) throw new Error("META_APP_SECRET not set");
  if (!current) throw new Error("META_ACCESS_TOKEN not set");

  assertWritable("roll the Meta token");

  const before = await inspectToken(current);
  if (!before.is_valid) {
    throw new MetaAuthError(
      "Meta token is already expired/invalid — fb_exchange_token cannot revive it. " +
        "Re-auth via Graph API Explorer, then run `npm run tokens:seed:meta <short-lived-token>`.",
    );
  }

  const url = new URL(`${GRAPH}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("fb_exchange_token", current);

  const res = await fetch(url);
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: { message: string };
  };
  if (!res.ok || data.error || !data.access_token) {
    throw new MetaAuthError(`Meta token exchange failed: ${data.error?.message ?? res.status}`);
  }

  process.env.META_ACCESS_TOKEN = data.access_token;
  await updateEnvFile({ META_ACCESS_TOKEN: data.access_token });

  const after = await inspectToken(data.access_token);
  const expiresAt = after.expires_at ? new Date(after.expires_at * 1000).toISOString() : undefined;
  if (expiresAt) {
    process.env.META_TOKEN_EXPIRES_AT = expiresAt;
    await updateEnvFile({ META_TOKEN_EXPIRES_AT: expiresAt });
  } else if (data.expires_in) {
    await recordExpiry("META_TOKEN_EXPIRES_AT", data.expires_in);
  }

  const beforeIso = before.expires_at ? new Date(before.expires_at * 1000).toISOString() : "unknown";
  console.error(
    `[meta] long-lived token rolled; expiry ${beforeIso} -> ${expiresAt ?? "unknown"}` +
      `; scopes: ${(after.scopes ?? []).join(", ") || "(none reported)"}`,
  );
  return data.access_token;
}

/**
 * Seed from a fresh short-lived Graph Explorer token: exchanges it for a
 * 60-day long-lived one and stores it. This is the ONE manual step Meta needs,
 * and only when the token has been left to fully expire.
 */
export async function seedFromShortLivedToken(shortLived: string): Promise<string> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) throw new Error("META_APP_ID / META_APP_SECRET not set");

  assertWritable("seed the Meta token");

  const url = new URL(`${GRAPH}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("fb_exchange_token", shortLived);

  const res = await fetch(url);
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: { message: string };
  };
  if (!res.ok || data.error || !data.access_token) {
    throw new MetaAuthError(`Meta seed exchange failed: ${data.error?.message ?? res.status}`);
  }

  process.env.META_ACCESS_TOKEN = data.access_token;
  await updateEnvFile({ META_ACCESS_TOKEN: data.access_token });

  const info = await inspectToken(data.access_token);
  const expiresAt = info.expires_at ? new Date(info.expires_at * 1000).toISOString() : undefined;
  if (expiresAt) {
    process.env.META_TOKEN_EXPIRES_AT = expiresAt;
    await updateEnvFile({ META_TOKEN_EXPIRES_AT: expiresAt });
  }
  const scopes = info.scopes ?? [];
  console.error(
    `[meta] seeded long-lived token; expires ${expiresAt ?? "unknown"}; scopes: ${scopes.join(", ")}`,
  );
  if (!scopes.includes("ads_read")) {
    console.error("[meta] WARNING: token lacks ads_read — the insights pull will fail.");
  }
  return data.access_token;
}

export async function ensureFreshToken(): Promise<
  { renewed: boolean; reason: string; daysLeft?: number }
> {
  let left = daysUntil(process.env.META_TOKEN_EXPIRES_AT);

  // No recorded expiry (first run after this change) — ask Meta directly.
  if (left === undefined) {
    const info = await inspectToken();
    if (info.expires_at) {
      const iso = new Date(info.expires_at * 1000).toISOString();
      process.env.META_TOKEN_EXPIRES_AT = iso;
      assertWritable("record the Meta token expiry");
      await updateEnvFile({ META_TOKEN_EXPIRES_AT: iso });
      left = daysUntil(iso);
    } else if (info.is_valid) {
      return { renewed: false, reason: "never expires (system user token)" };
    }
  }

  if (left !== undefined && left > RENEW_WHEN_DAYS_LEFT) {
    return { renewed: false, reason: `${left.toFixed(1)}d left`, daysLeft: left };
  }
  const why = left === undefined ? "expiry unknown" : `${left.toFixed(1)}d left`;
  await rollLongLivedToken();
  return { renewed: true, reason: why, daysLeft: daysUntil(process.env.META_TOKEN_EXPIRES_AT) };
}
