import { assertWritable, updateEnvFile } from "./tokenStore.js";

const GRAPH_API = "https://graph.facebook.com/v20.0";

// A long-lived Meta user token lasts ~60 days. Refresh once it's inside this
// window so a few consecutive missed runs (Mac asleep, etc.) can't strand us
// with a dead token — the runbook's manual cadence was "rotate at ~55 days".
const REFRESH_WHEN_DAYS_LEFT = 7;

const SECONDS_PER_DAY = 86_400;

export type MetaTokenInfo = {
  isValid: boolean;
  /** Unix seconds. 0 means "never expires" (system user tokens). */
  expiresAt: number;
  /** Days until expiry. `Infinity` when the token never expires. */
  daysLeft: number;
  type: string;
  scopes: string[];
  /** Present when Meta reports the token as invalid/expired. */
  error?: string;
};

export class MetaTokenExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaTokenExpiredError";
  }
}

function readAppCreds(): { appId: string; appSecret: string } {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId) throw new Error("META_APP_ID not set — needed for token refresh");
  if (!appSecret) throw new Error("META_APP_SECRET not set — needed for token refresh");
  return { appId, appSecret };
}

function daysFromExpiry(expiresAt: number): number {
  // Meta uses expires_at === 0 to mean "never expires" (system user tokens).
  if (expiresAt === 0) return Infinity;
  return (expiresAt - Date.now() / 1000) / SECONDS_PER_DAY;
}

/**
 * Ask Meta about a token: is it valid, when does it die, what scopes does it
 * carry. Uses an app access token (`APP_ID|APP_SECRET`) as the inspecting
 * credential, which is what /debug_token expects.
 */
export async function inspectToken(token: string): Promise<MetaTokenInfo> {
  const { appId, appSecret } = readAppCreds();
  const params = new URLSearchParams({
    input_token: token,
    access_token: `${appId}|${appSecret}`,
  });

  const res = await fetch(`${GRAPH_API}/debug_token?${params.toString()}`);
  const body = (await res.json()) as {
    data?: {
      is_valid?: boolean;
      expires_at?: number;
      type?: string;
      scopes?: string[];
      error?: { message?: string };
    };
    error?: { message?: string };
  };

  if (!res.ok && !body.data) {
    throw new Error(
      `Meta debug_token ${res.status}: ${body.error?.message ?? "unknown error"}`,
    );
  }

  const data = body.data ?? {};
  const expiresAt = data.expires_at ?? 0;
  return {
    isValid: data.is_valid === true,
    expiresAt,
    daysLeft: daysFromExpiry(expiresAt),
    type: data.type ?? "UNKNOWN",
    scopes: data.scopes ?? [],
    error: data.error?.message,
  };
}

/**
 * Exchange the current long-lived token for a fresh one via `fb_exchange_token`.
 * Returns the new token plus what actually happened to the expiry.
 *
 * IMPORTANT CAVEAT: Meta documents `fb_exchange_token` as the short-lived →
 * long-lived swap. Re-exchanging an already-long-lived *user* token is not
 * guaranteed to push the expiry out — Meta has historically returned a token
 * carrying the ORIGINAL expiry. So we measure the before/after expiry and
 * report the truth rather than assuming the refresh worked. If `extended` comes
 * back false, this whole auto-roll is a no-op for your token type and the real
 * fix is a System User token (never expires) — see TOKEN_ROTATION.md.
 */
export async function exchangeForLongLived(
  currentToken: string,
): Promise<{ token: string; before: MetaTokenInfo; after: MetaTokenInfo; extended: boolean }> {
  const { appId, appSecret } = readAppCreds();
  // Before the exchange, not after — a token we can't write down is a token
  // we've lost. See tokenStore.assertWritable().
  assertWritable("exchange the Meta token");
  const before = await inspectToken(currentToken);

  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: currentToken,
  });

  const res = await fetch(`${GRAPH_API}/oauth/access_token?${params.toString()}`);
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Meta token exchange failed ${res.status}: ${errBody.slice(0, 400)}`);
  }

  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Meta token exchange returned no access_token");

  const after = await inspectToken(data.access_token);
  // Treat "moved the expiry meaningfully forward" as the bar, not just any
  // change — a few seconds of drift isn't an extension.
  const extended = after.expiresAt === 0 || after.expiresAt > before.expiresAt + SECONDS_PER_DAY;

  return { token: data.access_token, before, after, extended };
}

/**
 * Called at the top of each Meta pull. Checks the current token's remaining
 * life and proactively rolls it when it's close to expiry, persisting the new
 * token to .env so tomorrow's scheduled run starts fresh.
 *
 * Returns the token to use for this run.
 *
 * Throws MetaTokenExpiredError when the token is already dead — that case
 * cannot be self-healed (`fb_exchange_token` extends a *live* token; it can't
 * resurrect an expired one) and needs the manual seeding flow.
 */
export async function ensureFreshMetaToken(): Promise<string> {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error("META_ACCESS_TOKEN not set");

  let info: MetaTokenInfo;
  try {
    info = await inspectToken(token);
  } catch (err) {
    // Don't take down the pull just because the introspection call failed —
    // let the actual insights request produce the real error.
    console.error(
      "[meta] token introspection failed, proceeding with existing token:",
      err instanceof Error ? err.message : err,
    );
    return token;
  }

  if (!info.isValid) {
    throw new MetaTokenExpiredError(
      `Meta access token is invalid/expired${info.error ? ` (${info.error})` : ""}. ` +
        `fb_exchange_token cannot revive an expired token — reseed it with ` +
        `\`npm run meta:token seed\` (see TOKEN_ROTATION.md).`,
    );
  }

  if (info.daysLeft === Infinity) {
    console.error(`[meta] token never expires (${info.type}) — no rotation needed`);
    return token;
  }

  if (info.daysLeft > REFRESH_WHEN_DAYS_LEFT) {
    console.error(`[meta] token healthy, ~${Math.floor(info.daysLeft)}d left`);
    return token;
  }

  console.error(
    `[meta] token has ~${Math.floor(info.daysLeft)}d left (threshold ${REFRESH_WHEN_DAYS_LEFT}d) — attempting auto-roll`,
  );

  try {
    const { token: fresh, after, extended } = await exchangeForLongLived(token);
    process.env.META_ACCESS_TOKEN = fresh;
    await updateEnvFile({ META_ACCESS_TOKEN: fresh });

    if (extended) {
      console.error(`[meta] token auto-rolled; ~${Math.floor(after.daysLeft)}d left`);
    } else {
      // The exchange "succeeded" but bought us nothing. Say so loudly — a
      // silent no-op here is how you end up expired again in a week.
      console.error(
        `[meta] WARNING: auto-roll did not extend expiry (still ~${Math.floor(after.daysLeft)}d left). ` +
          `fb_exchange_token does not renew this token type. Switch to a System User token — see TOKEN_ROTATION.md.`,
      );
    }
    return fresh;
  } catch (err) {
    // Refresh failed but the token is still valid today — run with it and let
    // the operator see the warning.
    console.error(
      `[meta] auto-roll failed (token still valid ~${Math.floor(info.daysLeft)}d):`,
      err instanceof Error ? err.message : err,
    );
    return token;
  }
}
