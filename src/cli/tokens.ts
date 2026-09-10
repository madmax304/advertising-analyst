import "dotenv/config";
import { stdin } from "node:process";
import { daysUntil, ENV_FILE } from "../adapters/tokenStore.js";
import * as pinterestAuth from "../adapters/pinterestAuth.js";
import type { Platform } from "../types.js";

/**
 * Token health + renewal.
 *
 *   npm run tokens                 status table (read-only, no rotation)
 *   npm run tokens:renew           renew anything close to expiry
 *   npm run tokens:authurl         Pinterest re-auth URL, all scopes
 *   pbpaste | npm run tokens:seed:pinterest
 *
 * Scope note: Meta *rotation* deliberately lives in `src/adapters/metaAuth.ts`
 * and `npm run meta:token` — this module only READS Meta's token state, so the
 * two don't duplicate each other. Pinterest rotation lives here because it is
 * inseparable from the scope handling in pinterestAuth.ts.
 *
 * The digest calls renewTokens() as a preflight, so in normal operation this
 * CLI is only for humans who want to look.
 */

export type TokenHealth = {
  platform: Platform;
  ok: boolean;
  daysLeft?: number;
  detail: string;
  /** true when only a human can fix it (re-auth needed) */
  needsManualAuth?: boolean;
};

const GRAPH = "https://graph.facebook.com/v20.0";
const TIKTOK_API = "https://business-api.tiktok.com/open_api/v1.3";
const PINTEREST_API = "https://api.pinterest.com/v5";

/** Live check: does the Pinterest token work, and does it still hold every scope? */
async function checkPinterest(): Promise<TokenHealth> {
  const token = process.env.PINTEREST_ACCESS_TOKEN;
  const acct = process.env.PINTEREST_AD_ACCOUNT_ID;
  const daysLeft = daysUntil(process.env.PINTEREST_TOKEN_EXPIRES_AT);
  if (!token || !acct) {
    return { platform: "pinterest", ok: false, detail: "credentials missing from .env" };
  }

  const missing: string[] = [];
  // ads:read — the reporting pull
  const adsRes = await fetch(`${PINTEREST_API}/ad_accounts/${acct}/ads?page_size=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (adsRes.status === 401) {
    const body = await adsRes.text();
    return {
      platform: "pinterest",
      ok: false,
      daysLeft,
      detail: `reporting 401: ${body.slice(0, 160)}`,
      needsManualAuth: /Missing: \[/.test(body),
    };
  }
  if (!adsRes.ok) {
    return { platform: "pinterest", ok: false, daysLeft, detail: `reporting HTTP ${adsRes.status}` };
  }

  // pins:read + boards:read — the thumbnail path. A bogus pin id is enough:
  // a scope failure answers 401 before the pin is ever looked up.
  const pinRes = await fetch(`${PINTEREST_API}/pins/000000000000000001`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (pinRes.status === 401) {
    const body = await pinRes.text();
    const m = body.match(/Missing: \[([^\]]*)\]/);
    const list = m?.[1];
    if (list) missing.push(...list.split(",").map((s) => s.trim().replace(/['"]/g, "")));
  }

  if (missing.length > 0) {
    return {
      platform: "pinterest",
      ok: false,
      daysLeft,
      detail: `reporting OK, but missing ${missing.join(", ")} — thumbnails will not render`,
      needsManualAuth: true,
    };
  }
  return {
    platform: "pinterest",
    ok: true,
    daysLeft,
    detail: `all scopes present${daysLeft !== undefined ? `, ${daysLeft.toFixed(0)}d left` : ""}`,
  };
}

type MetaDebugToken = {
  is_valid: boolean;
  expires_at?: number; // unix seconds; 0 means "never"
  scopes?: string[];
  type?: string;
};

/** Read-only: ask Meta about its own token rather than guessing from .env. */
async function inspectMetaToken(): Promise<MetaDebugToken> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const input = process.env.META_ACCESS_TOKEN;
  if (!appId || !appSecret) throw new Error("META_APP_ID / META_APP_SECRET not set");
  if (!input) throw new Error("META_ACCESS_TOKEN not set");

  const url = new URL(`${GRAPH}/debug_token`);
  url.searchParams.set("input_token", input);
  url.searchParams.set("access_token", `${appId}|${appSecret}`);
  const res = await fetch(url);
  const body = (await res.json()) as { data?: MetaDebugToken; error?: { message: string } };
  if (!res.ok || body.error) {
    throw new Error(`Meta debug_token failed: ${body.error?.message ?? res.status}`);
  }
  return body.data ?? { is_valid: false };
}

async function checkMeta(): Promise<TokenHealth> {
  try {
    const info = await inspectMetaToken();
    const daysLeft = info.expires_at
      ? (info.expires_at * 1000 - Date.now()) / 86_400_000
      : undefined;
    if (!info.is_valid) {
      return {
        platform: "meta",
        ok: false,
        daysLeft,
        detail: "token expired or revoked — fb_exchange_token cannot revive it",
        needsManualAuth: true,
      };
    }
    const scopes = info.scopes ?? [];
    if (!scopes.includes("ads_read")) {
      return {
        platform: "meta",
        ok: false,
        daysLeft,
        detail: `valid but missing ads_read (has: ${scopes.join(", ") || "none"})`,
        needsManualAuth: true,
      };
    }
    // A USER token has to be rolled every 60d; a SYSTEM_USER token never expires.
    const kind = info.type === "SYSTEM_USER" ? "system-user" : "user";
    return {
      platform: "meta",
      ok: true,
      daysLeft,
      detail:
        daysLeft === undefined
          ? `never expires (${kind})`
          : `${daysLeft.toFixed(0)}d left (${kind} token)`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      platform: "meta",
      ok: false,
      detail: message,
      needsManualAuth: /OAuthException|code"?\s*:?\s*190|expired/i.test(message),
    };
  }
}

async function checkTikTok(): Promise<TokenHealth> {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  const advertiserId = process.env.TIKTOK_ADVERTISER_ID;
  if (!token || !advertiserId) {
    return { platform: "tiktok", ok: false, detail: "credentials missing from .env" };
  }
  // Probe the SAME endpoint the digest depends on. An earlier version of this
  // check called /advertiser/info/, which this token is not scoped for — it
  // reported RE-AUTH while the reporting pull was working perfectly. Check what
  // you actually rely on, not what's convenient to call.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const url = new URL(`${TIKTOK_API}/report/integrated/get/`);
  url.searchParams.set("advertiser_id", advertiserId);
  url.searchParams.set("report_type", "BASIC");
  url.searchParams.set("data_level", "AUCTION_AD");
  url.searchParams.set("dimensions", JSON.stringify(["ad_id"]));
  url.searchParams.set("metrics", JSON.stringify(["spend"]));
  url.searchParams.set("start_date", yesterday);
  url.searchParams.set("end_date", yesterday);
  url.searchParams.set("page", "1");
  url.searchParams.set("page_size", "1");

  const res = await fetch(url, { headers: { "Access-Token": token } });
  const body = (await res.json()) as { code?: number; message?: string };
  // TikTok answers HTTP 200 with a non-zero code in the body on auth failure.
  if (body.code !== 0) {
    return {
      platform: "tiktok",
      ok: false,
      detail: `reporting code=${body.code} ${body.message ?? ""}`.trim(),
      needsManualAuth: true,
    };
  }
  // TikTok's long-term token carries no expiry we can read back, so the .env
  // note is the only date we have. Monitoring is the automation here — there is
  // no refresh_token captured yet to roll it with.
  const daysLeft = daysUntil(process.env.TIKTOK_TOKEN_EXPIRES_AT);
  return {
    platform: "tiktok",
    ok: true,
    daysLeft,
    detail:
      daysLeft === undefined
        ? "valid (no expiry recorded — see TOKEN_ROTATION.md)"
        : `valid, ~${daysLeft.toFixed(0)}d left`,
  };
}

export async function checkAll(): Promise<TokenHealth[]> {
  return Promise.all([checkMeta(), checkTikTok(), checkPinterest()]);
}

/**
 * Renew whatever can be renewed without a human. Never throws: a platform that
 * can't be renewed is reported, not fatal, so one dead token doesn't stop the
 * others from being kept alive.
 */
export async function renewTokens(): Promise<string[]> {
  const notes: string[] = [];
  // Pinterest only. Meta rotation is owned by metaAuth.ts (`npm run meta:token`);
  // once that lands on main, add its ensureFreshMetaToken() to this list so the
  // digest preflight renews both.
  for (const [name, ensure] of [["pinterest", pinterestAuth.ensureFreshToken]] as const) {
    try {
      const r = await ensure();
      notes.push(`${name}: ${r.renewed ? `renewed (was ${r.reason})` : `no action (${r.reason})`}`);
    } catch (err) {
      notes.push(`${name}: renewal failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return notes;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/**
 * Read a secret from stdin so it never lands in shell history or a process
 * list. `pbpaste | npm run tokens:seed:pinterest` is the smooth path. Passing the
 * value as an argv argument still works but is discouraged for exactly that
 * reason — argv is visible to `ps` and gets written to ~/.zsh_history.
 */
async function readSecretFromStdin(): Promise<string | undefined> {
  if (stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  const value = Buffer.concat(chunks).toString("utf-8").trim();
  return value || undefined;
}

async function main(): Promise<void> {
  const [cmd, argvArg] = process.argv.slice(2);
  // Read stdin at most once — consuming it twice would return empty the second
  // time. Prefer piped input; fall back to argv, warning that it's on the record.
  const piped = cmd?.startsWith("seed") ? await readSecretFromStdin() : undefined;
  const arg = piped ?? argvArg;
  if (!piped && argvArg && cmd?.startsWith("seed")) {
    console.error(
      `[tokens] note: a secret passed as an argument is recorded in shell history — ` +
        `\`pbpaste | npm run tokens:${cmd}\` avoids that.`,
    );
  }

  if (cmd === "seed:pinterest") {
    if (!arg) throw new Error("usage: pbpaste | npm run tokens:seed:pinterest");
    await pinterestAuth.exchangeAuthCode(arg);
    console.log("Pinterest token seeded. Re-run `npm run tokens` to confirm.");
    return;
  }

  if (cmd === "authurl") {
    console.log("Pinterest re-auth — open this, approve, then copy the ?code= value:\n");
    console.log(`  ${pinterestAuth.buildAuthorizeUrl()}\n`);
    console.log("Then: npm run tokens:seed:pinterest -- <auth_code>");
    return;
  }

  if (cmd === "renew") {
    console.log(`Renewing tokens (.env: ${ENV_FILE})\n`);
    for (const note of await renewTokens()) console.log(`  ${note}`);
    console.log("");
  }

  const results = await checkAll();
  console.log(`Token health (.env: ${ENV_FILE})\n`);
  console.log(`  ${pad("PLATFORM", 11)}${pad("STATUS", 9)}DETAIL`);
  for (const r of results) {
    const status = r.ok ? "OK" : r.needsManualAuth ? "RE-AUTH" : "FAIL";
    console.log(`  ${pad(r.platform, 11)}${pad(status, 9)}${r.detail}`);
  }

  // Don't just say "a human is needed" — say exactly which command to run.
  const manual = results.filter((r) => r.needsManualAuth);
  if (manual.length > 0) {
    console.log(`\n${manual.length} token(s) need a one-time re-auth:\n`);
    for (const m of manual) {
      if (m.platform === "pinterest") {
        console.log("  pinterest — the refresh grant lost its scopes; rebuild it:");
        console.log(`    1. open: ${pinterestAuth.buildAuthorizeUrl()}`);
        console.log("    2. approve, copy the ?code= value from the redirect URL");
        console.log("    3. npm run tokens:seed:pinterest -- <auth_code>\n");
      } else if (m.platform === "meta") {
        console.log("  meta — expired past the point fb_exchange_token can revive:");
        console.log("    1. open: https://developers.facebook.com/tools/explorer/");
        console.log('    2. app "KPI Pulse", User Token, permission ads_read, Generate');
        console.log("    3. pbpaste | npm run meta:token seed\n");
      } else {
        console.log(`  ${m.platform} — see TOKEN_ROTATION.md\n`);
      }
    }
    console.log("Once seeded, renewal is automatic — the digest renews on every run.");
  }
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}

// Only run as a CLI — the digest imports renewTokens() from here.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  main().catch((err) => {
    console.error("[tokens] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
