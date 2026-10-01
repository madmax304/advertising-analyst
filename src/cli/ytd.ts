/**
 * YTD cost-per-conversion snapshot — Meta, TikTok, Pinterest.
 *
 * Pulls Jan 1 → today in monthly chunks so a single Meta call never spans nine
 * months of ad-level data (rate-limit and pagination risk). Aggregates per
 * network and prints trial/purchase/observed cost-per-conversion.
 *
 * One-off; scratch. Run with `npx tsx src/cli/ytd.ts` from the project root.
 */
import "dotenv/config";
import type { CreativeMetrics, DateRange, Platform } from "../types.js";
import { fetchCreativeMetrics as fetchMeta } from "../adapters/meta.js";
import { fetchCreativeMetrics as fetchTikTok } from "../adapters/tiktok.js";
import { fetchCreativeMetrics as fetchPinterest } from "../adapters/pinterest.js";
import { fetchObservedRevenue } from "../adapters/posthog.js";

const PLATFORMS: Platform[] = ["meta", "tiktok", "pinterest"];
const LABEL: Record<Platform, string> = { meta: "Meta", tiktok: "TikTok", pinterest: "Pinterest" };

const usd0 = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const usd2 = (n: number): string => `$${n.toFixed(2)}`;
const int = (n: number): string => Math.round(n).toLocaleString("en-US");
const pad = (s: string, n: number): string => (s.length >= n ? s : " ".repeat(n - s.length) + s);
const padR = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

function monthChunks(startIso: string, endIso: string): DateRange[] {
  const out: DateRange[] = [];
  const [sy, sm] = startIso.split("-").map(Number);
  const [ey, em] = endIso.split("-").map(Number);
  let y = sy!;
  let m = sm!;
  while (y < ey! || (y === ey! && m <= em!)) {
    const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
    const nextMonth = new Date(Date.UTC(y, m, 1));
    nextMonth.setUTCDate(nextMonth.getUTCDate() - 1);
    const monthEnd = nextMonth.toISOString().slice(0, 10);
    const chunkStart = monthStart < startIso ? startIso : monthStart;
    const chunkEnd = monthEnd > endIso ? endIso : monthEnd;
    out.push({ start: chunkStart, end: chunkEnd });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

const ADAPTERS = { meta: fetchMeta, tiktok: fetchTikTok, pinterest: fetchPinterest } as const;

type Totals = {
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  trialStarts: number;
  claimedRevenue: number;
};

const empty = (): Totals => ({
  spend: 0,
  impressions: 0,
  clicks: 0,
  purchases: 0,
  trialStarts: 0,
  claimedRevenue: 0,
});

async function pullWithRetry(
  p: Platform,
  range: DateRange,
): Promise<CreativeMetrics[]> {
  // Meta answers 403 code 4 when rate-limited (see memory). Wait and retry.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await ADAPTERS[p](range);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/rate|limit|429|"code":4[,}]|403/i.test(msg)) throw err;
      const waitS = 60 * (attempt + 1);
      process.stderr.write(`[ytd]   ${p} rate-limited, waiting ${waitS}s…\n`);
      await new Promise((r) => setTimeout(r, waitS * 1000));
    }
  }
  throw lastErr;
}

async function pullYear(): Promise<{
  perNetwork: Record<Platform, Totals>;
  chunks: DateRange[];
  errors: string[];
}> {
  const today = new Date().toISOString().slice(0, 10);
  const chunks = monthChunks("2026-01-01", today);
  const perNetwork: Record<Platform, Totals> = {
    meta: empty(),
    tiktok: empty(),
    pinterest: empty(),
  };
  const errors: string[] = [];

  for (const range of chunks) {
    process.stderr.write(`[ytd] ${range.start} → ${range.end}\n`);
    for (const p of PLATFORMS) {
      try {
        const rows = await pullWithRetry(p, range);
        const t = perNetwork[p];
        for (const r of rows) {
          t.spend += r.spend;
          t.impressions += r.impressions;
          t.clicks += r.clicks;
          t.purchases += r.purchases;
          t.trialStarts += r.trialStarts;
          t.claimedRevenue += r.revenue;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${p} ${range.start}..${range.end}: ${msg}`);
        process.stderr.write(`[ytd]   ${p} FAILED: ${msg.slice(0, 200)}\n`);
      }
    }
  }
  return { perNetwork, chunks, errors };
}

async function pullObserved(range: DateRange) {
  try {
    return await fetchObservedRevenue(range);
  } catch (err) {
    process.stderr.write(
      `[ytd] observed failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  }
}

function costPer(spend: number, count: number): string {
  if (count <= 0) return "—";
  return usd2(spend / count);
}

async function main() {
  const { perNetwork, chunks, errors } = await pullYear();
  const first = chunks[0]!.start;
  const last = chunks[chunks.length - 1]!.end;

  const observed = await pullObserved({ start: first, end: last });
  const observedByNet: Record<Platform, number> = { meta: 0, tiktok: 0, pinterest: 0 };
  if (observed) {
    for (const n of observed.networks) observedByNet[n.platform] = n.conversions;
  }

  console.log(`\n=== YTD ${first} → ${last} ===\n`);

  console.log(
    "NETWORK       spend      trials    $/trial     purch*    $/purch*    obs new**   CPA obs**",
  );
  for (const p of PLATFORMS) {
    const t = perNetwork[p];
    const trialCell = p === "tiktok" ? "n/a" : int(t.trialStarts);
    const costTrialCell = p === "tiktok" ? "broken" : costPer(t.spend, t.trialStarts);
    const obs = observedByNet[p];
    console.log(
      "  " +
        padR(LABEL[p], 11) +
        pad(usd0(t.spend), 10) +
        pad(trialCell, 10) +
        pad(costTrialCell, 12) +
        pad(int(t.purchases), 10) +
        pad(costPer(t.spend, t.purchases), 12) +
        pad(int(obs), 12) +
        pad(costPer(t.spend, obs), 12),
    );
  }

  const totalSpend = PLATFORMS.reduce((a, p) => a + perNetwork[p]!.spend, 0);
  const totalObs = PLATFORMS.reduce((a, p) => a + observedByNet[p]!, 0);
  console.log(
    "  " +
      padR("TOTAL", 11) +
      pad(usd0(totalSpend), 10) +
      pad("", 10) +
      pad("", 12) +
      pad("", 10) +
      pad("", 12) +
      pad(int(totalObs), 12) +
      pad(costPer(totalSpend, totalObs), 12),
  );

  console.log(
    "\n  * purch = each network's own Purchase event. INCLUDES RENEWALS on Meta &\n" +
      "    TikTok — it is not a pure new-customer count. Pinterest reports Checkouts.",
  );
  console.log(
    "  ** obs new / CPA obs = new customers observed in PostHog via click-ID join\n" +
      "     (rc_initial_purchase + rc_trial_converted). Independent of what the\n" +
      "     networks claim. Only ~40% of RC conversions join any ad click, so this\n" +
      "     is a FLOOR — real CPA is lower than the CPA obs column.",
  );

  if (observed) {
    const c = observed.coverage;
    const covRev = c.revenue > 0 ? (c.joinableRevenue / c.revenue) * 100 : 0;
    const covConv = c.conversions > 0 ? (c.joinableConversions / c.conversions) * 100 : 0;
    console.log(
      `\n  PostHog coverage YTD: ${covConv.toFixed(1)}% of new-money conversions ` +
        `(${covRev.toFixed(1)}% of revenue) joined to a click.`,
    );
  }

  if (errors.length > 0) {
    console.log("\nPULL ERRORS");
    for (const e of errors) console.log("  " + e);
  }
}

main().catch((err) => {
  console.error("[ytd] fatal:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
