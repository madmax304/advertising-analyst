import "dotenv/config";
import { fetchCreativeMetrics as fetchPinterest } from "../adapters/pinterest.js";
// fetchPinterestThumbnails is intentionally not wired: it needs pins:read +
// boards:read scopes on the Pinterest token. Current token has only ads:read.
// Re-authorize with broader scope to enable Pinterest thumbnails.
import {
  fetchCreativeMetrics as fetchMeta,
  fetchThumbnails as fetchMetaThumbnails,
} from "../adapters/meta.js";
import { fetchCreativeMetrics as fetchTikTok } from "../adapters/tiktok.js";
import { summarize } from "../analyst/summarize.js";
import { rankCreatives, type RankedCreative } from "../analyst/rankCreatives.js";
import { buildDigestBlocks, postDigest, type PlatformSection } from "../slack/digest.js";
import type { CreativeMetrics, Platform } from "../types.js";

const TIMEZONE = "America/Los_Angeles";
// Trailing 7 complete days (excludes today since it's still partial).
const WINDOW_DAYS = 7;
// Separate floors per ranking lens. Spend list is for "where's the budget" — a
// $250 7-day floor (≈$36/d) keeps it focused on real bets. ROAS list is for
// "what's efficient" — lower $50 floor so a promising-but-underfunded $80
// creative at 3x ROAS can surface as "should we scale this?" signal.
const SPEND_FLOOR_FOR_SPEND_LIST = 250;
const SPEND_FLOOR_FOR_ROAS_LIST = 50;

/** Returns a YYYY-MM-DD date string N days ago in the given timezone. */
function daysAgoInTz(daysAgo: number, tz: string): string {
  const now = new Date();
  const shifted = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  if (!y || !m || !d) throw new Error(`Unable to format date (${daysAgo}d ago) in ${tz}`);
  return `${y}-${m}-${d}`;
}

type AdapterFn = (range: { start: string; end: string }) => Promise<CreativeMetrics[]>;
type ThumbFn = (adIds: string[]) => Promise<Record<string, { thumbnailUrl?: string; previewUrl?: string }>>;

const ADAPTERS: Partial<
  Record<Platform, { fetch: AdapterFn; window: string; fetchThumbnails?: ThumbFn }>
> = {
  meta: { fetch: fetchMeta, window: "7-day click", fetchThumbnails: fetchMetaThumbnails },
  // TikTok's current OAuth scope doesn't include /ad/get/, /creative/* — all
  // three return 40001 permission errors. Text-only until we widen the scope.
  tiktok: { fetch: fetchTikTok, window: "7-day click / 1-day view" },
  pinterest: { fetch: fetchPinterest, window: "30-day click" },
};

/**
 * Batch-fetch thumbnails for the union of ad IDs across multiple lists, then
 * apply the same enrichment back to each list. Single API call even when the
 * lists overlap or we pass more than one.
 */
async function enrichLists(
  lists: RankedCreative[][],
  fetchThumbnails: ThumbFn | undefined,
): Promise<RankedCreative[][]> {
  if (!fetchThumbnails) return lists;
  const allAdIds = [...new Set(lists.flatMap((list) => list.map((c) => c.adId)))];
  if (allAdIds.length === 0) return lists;

  let enrichment: Record<string, { thumbnailUrl?: string; previewUrl?: string }> = {};
  try {
    enrichment = await fetchThumbnails(allAdIds);
  } catch (err) {
    console.error(
      "[digest] thumbnail enrichment failed, rendering text-only:",
      err instanceof Error ? err.message : err,
    );
    return lists;
  }

  return lists.map((list) =>
    list.map((c) => ({
      ...c,
      thumbnailUrl: enrichment[c.adId]?.thumbnailUrl,
      previewUrl: enrichment[c.adId]?.previewUrl,
    })),
  );
}

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
    // Rank by spend first (the "where's the budget" lens), then by ROAS
    // excluding anything already shown in the spend list (dedup).
    const rawSpend = rankCreatives(rows, {
      by: "spend",
      n: 3,
      minSpend: SPEND_FLOOR_FOR_SPEND_LIST,
    });
    const rawRoas = rankCreatives(rows, {
      by: "roas",
      n: 3,
      minSpend: SPEND_FLOOR_FOR_ROAS_LIST,
      excludeAdIds: rawSpend.map((c) => c.adId),
    });
    const [topBySpend, topByRoas] = await enrichLists(
      [rawSpend, rawRoas],
      adapter.fetchThumbnails,
    );
    return {
      ok: true,
      platform,
      attributionWindow: adapter.window,
      summary: summarize(rows),
      topBySpend: topBySpend ?? rawSpend,
      topByRoas: topByRoas ?? rawRoas,
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
  // Trailing-7-days window: ends yesterday (last fully-complete day),
  // starts N days before that. E.g. on 2026-04-20 → 2026-04-13 through 2026-04-19.
  const end = daysAgoInTz(1, TIMEZONE);
  const start = daysAgoInTz(WINDOW_DAYS, TIMEZONE);
  const range = { start, end };

  // Section order in the Slack digest: Meta → TikTok → Pinterest.
  // Any platform missing creds in .env renders as an error section and doesn't
  // take down the others (see runPlatform).
  const platforms: Platform[] = ["meta", "tiktok", "pinterest"];

  const sections = await Promise.all(platforms.map((p) => runPlatform(p, range)));

  const dryRun = process.env.DIGEST_DRY_RUN === "1";
  if (dryRun) {
    const blocks = buildDigestBlocks(range, sections);
    console.log(
      JSON.stringify({ text: `7-Day Media Digest — ${start} to ${end}`, blocks }, null, 2),
    );
  } else {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) throw new Error("SLACK_WEBHOOK_URL not set (use DIGEST_DRY_RUN=1 to preview)");
    await postDigest(webhookUrl, range, sections);
    console.error(`[digest] posted for ${start} to ${end}`);
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
