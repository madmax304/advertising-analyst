import "dotenv/config";
import { fetchCreativeMetrics as fetchPinterest } from "../adapters/pinterest.js";
import { fetchCreativeMetrics as fetchMeta } from "../adapters/meta.js";
import { fetchCreativeMetrics as fetchTikTok } from "../adapters/tiktok.js";
import { summarize } from "../analyst/summarize.js";
import { rankCreatives } from "../analyst/rankCreatives.js";
import { buildDigestBlocks, postDigest, type PlatformSection } from "../slack/digest.js";
import type { CreativeMetrics, Platform } from "../types.js";

const TIMEZONE = "America/Los_Angeles";

/** Returns yesterday's date in the given tz as YYYY-MM-DD. */
function yesterdayInTz(tz: string): string {
  const now = new Date();
  // Shift `now` 24h into the past, then format in the target tz.
  const shifted = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  if (!y || !m || !d) throw new Error(`Unable to format yesterday in ${tz}`);
  return `${y}-${m}-${d}`;
}

type AdapterFn = (range: { start: string; end: string }) => Promise<CreativeMetrics[]>;

const ADAPTERS: Partial<Record<Platform, { fetch: AdapterFn; window: string }>> = {
  meta: { fetch: fetchMeta, window: "7-day click" },
  tiktok: { fetch: fetchTikTok, window: "7-day click / 1-day view" },
  pinterest: { fetch: fetchPinterest, window: "30-day click" },
};

async function runPlatform(
  platform: Platform,
  range: { start: string; end: string },
): Promise<PlatformSection> {
  const adapter = ADAPTERS[platform];
  if (!adapter) {
    return { ok: false, platform, error: `adapter not yet implemented` };
  }
  try {
    const rows = await adapter.fetch(range);
    return {
      ok: true,
      platform,
      attributionWindow: adapter.window,
      summary: summarize(rows),
      topCreatives: rankCreatives(rows, { by: "roas", n: 3, minSpend: 50 }),
    };
  } catch (err) {
    return {
      ok: false,
      platform,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const date = yesterdayInTz(TIMEZONE);
  const range = { start: date, end: date };

  // Section order in the Slack digest: Meta → TikTok → Pinterest.
  // Any platform missing creds in .env renders as an error section and doesn't
  // take down the others (see runPlatform).
  const platforms: Platform[] = ["meta", "tiktok", "pinterest"];

  const sections = await Promise.all(platforms.map((p) => runPlatform(p, range)));

  const dryRun = process.env.DIGEST_DRY_RUN === "1";
  if (dryRun) {
    const blocks = buildDigestBlocks(date, sections);
    console.log(JSON.stringify({ text: `Daily Media Digest — ${date}`, blocks }, null, 2));
  } else {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) throw new Error("SLACK_WEBHOOK_URL not set (use DIGEST_DRY_RUN=1 to preview)");
    await postDigest(webhookUrl, date, sections);
    console.error(`[digest] posted for ${date}`);
  }

  const failed = sections.filter((s): s is Extract<PlatformSection, { ok: false }> => !s.ok);
  if (failed.length > 0) {
    for (const f of failed) console.error(`[digest] ${f.platform} failed: ${f.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[digest] fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
