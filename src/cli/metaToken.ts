import "dotenv/config";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import {
  inspectToken,
  exchangeForLongLived,
  type MetaTokenInfo,
} from "../adapters/metaAuth.js";
import { updateEnvFile } from "../adapters/tokenStore.js";

/**
 * Meta token management. Deliberately never prints a token value — secrets
 * that land in a terminal transcript have to be rotated again (see
 * TOKEN_ROTATION.md "General tips").
 *
 *   npm run meta:token           # status: is it alive, how long left
 *   npm run meta:token seed      # exchange a short-lived token → 60-day, write .env
 *   npm run meta:token refresh   # force the long-lived → long-lived exchange
 */

function fmtDays(info: MetaTokenInfo): string {
  if (info.daysLeft === Infinity) return "never expires";
  const d = Math.floor(info.daysLeft);
  if (d < 0) return `expired ${Math.abs(d)}d ago`;
  return `~${d}d left`;
}

function fmtExpiry(info: MetaTokenInfo): string {
  if (info.expiresAt === 0) return "never";
  return new Date(info.expiresAt * 1000).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function printInfo(label: string, info: MetaTokenInfo): void {
  console.log(`${label}:`);
  console.log(`  valid:   ${info.isValid ? "yes" : `NO${info.error ? ` — ${info.error}` : ""}`}`);
  console.log(`  type:    ${info.type}`);
  console.log(`  expires: ${fmtExpiry(info)} (${fmtDays(info)})`);
  console.log(`  scopes:  ${info.scopes.join(", ") || "(none reported)"}`);
}

/**
 * Read a secret without echoing it. Supports piping too, so the smoothest path
 * is `pbpaste | npm run meta:token seed` — the token never gets typed, never
 * hits shell history, never appears on screen.
 */
async function readSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf-8").trim();
  }

  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    const iface = rl as unknown as { _writeToOutput: (s: string) => void };
    const original = iface._writeToOutput.bind(rl);
    // Echo the prompt itself, swallow everything the user types after it.
    iface._writeToOutput = (s: string) => {
      if (s.includes(prompt)) original(s);
    };
    rl.question(prompt, (answer) => {
      iface._writeToOutput = original;
      stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function cmdStatus(): Promise<void> {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    console.error("META_ACCESS_TOKEN not set in .env");
    process.exit(1);
  }
  const info = await inspectToken(token);
  printInfo("META_ACCESS_TOKEN", info);

  if (!info.isValid) {
    console.log("");
    console.log("Token is dead. Reseed it:");
    console.log("  1. https://developers.facebook.com/tools/explorer/");
    console.log("  2. App: KPI Pulse (527408709796464) · User Token · permission ads_read");
    console.log("  3. Generate, copy, then:  pbpaste | npm run meta:token seed");
    process.exit(1);
  }
  if (info.daysLeft !== Infinity && info.daysLeft < 14) {
    console.log("");
    console.log(`Heads up: under 14 days left. The digest auto-rolls under 7d,`);
    console.log(`but run \`npm run meta:token refresh\` to roll it now.`);
  }
}

async function cmdSeed(): Promise<void> {
  const shortLived = await readSecret("Paste the short-lived token (input hidden): ");
  if (!shortLived) {
    console.error("No token provided.");
    process.exit(1);
  }

  const incoming = await inspectToken(shortLived);
  if (!incoming.isValid) {
    console.error(`That token is not valid${incoming.error ? ` — ${incoming.error}` : ""}.`);
    process.exit(1);
  }
  if (!incoming.scopes.includes("ads_read")) {
    console.error(
      `That token lacks the ads_read scope (has: ${incoming.scopes.join(", ") || "none"}). ` +
        `The insights pull will 403. Regenerate with ads_read checked.`,
    );
    process.exit(1);
  }

  const { token, after, extended } = await exchangeForLongLived(shortLived);
  await updateEnvFile({ META_ACCESS_TOKEN: token });

  console.log("");
  printInfo("New META_ACCESS_TOKEN (written to .env)", after);
  if (!extended) {
    console.log("");
    console.log("WARNING: the exchange did not extend the expiry beyond the input token.");
    console.log("Verify you pasted a SHORT-lived token from Graph API Explorer.");
  }
  console.log("");
  console.log("Verify with:  npm run digest:dry");
}

async function cmdRefresh(): Promise<void> {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    console.error("META_ACCESS_TOKEN not set in .env");
    process.exit(1);
  }

  const current = await inspectToken(token);
  if (!current.isValid) {
    console.error("Current token is expired — fb_exchange_token cannot revive it.");
    console.error("Reseed instead:  pbpaste | npm run meta:token seed");
    process.exit(1);
  }

  const { token: fresh, before, after, extended } = await exchangeForLongLived(token);
  await updateEnvFile({ META_ACCESS_TOKEN: fresh });

  console.log(`before: ${fmtExpiry(before)} (${fmtDays(before)})`);
  console.log(`after:  ${fmtExpiry(after)} (${fmtDays(after)})`);
  console.log("");
  if (extended) {
    console.log("Expiry extended. Auto-roll works for this token type.");
  } else {
    console.log("Expiry NOT extended — fb_exchange_token is a no-op for this token type.");
    console.log("The durable fix is a System User token (never expires).");
    console.log("See TOKEN_ROTATION.md → 'Future fix: System User token'.");
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "status";
  switch (cmd) {
    case "status":
      return cmdStatus();
    case "seed":
      return cmdSeed();
    case "refresh":
      return cmdRefresh();
    default:
      console.error(`Unknown command "${cmd}". Use: status | seed | refresh`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("[meta:token]", err instanceof Error ? err.message : err);
  process.exit(1);
});
