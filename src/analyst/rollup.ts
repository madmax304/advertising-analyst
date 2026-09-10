import type { Platform } from "../types.js";
import type { Summary } from "./summarize.js";

/**
 * Minimal shape the roll-up needs from each platform. Declared here rather than
 * imported from the Slack layer so `analyst/` stays I/O- and presentation-free;
 * `PlatformSection` is structurally assignable to it.
 */
export type PlatformInput =
  | { ok: true; platform: Platform; attributionWindow: string; summary: Summary }
  | { ok: false; platform: Platform; error: string };

export type NetworkLine = {
  platform: Platform;
  attributionWindow: string;
  summary: Summary;
  /** Share of blended spend, 0–1. */
  spendShare: number;
};

export type Rollup = {
  /** Totals across every platform that pulled successfully. */
  blended: Summary;
  /** One line per successful platform, sorted by spend descending. */
  networks: NetworkLine[];
  /** Platforms left out because their pull failed. */
  excluded: { platform: Platform; error: string }[];
  /** True only when every attempted platform is represented in `blended`. */
  complete: boolean;
  /** Distinct attribution windows blended together — >1 means caveat the ROAS. */
  attributionWindows: string[];
};

function safeDiv(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Blend per-platform summaries into one cross-network view.
 *
 * Ratios (ROAS/CPA/CTR/CPM/Cost-per-trial) are recomputed from the summed
 * numerators and denominators — never averaged across platforms, which would
 * weight a $50 platform the same as a $50k one.
 *
 * ATTRIBUTION CAVEAT: the three platforms report on different windows (Meta
 * 7-day click, TikTok 7-day click/1-day view, Pinterest 30-day click). Summing
 * their revenue is therefore directional, not an accounting figure — Pinterest's
 * 30-day window will claim conversions Meta's 7-day window would never credit.
 * We surface `attributionWindows` so the renderer can say so out loud rather
 * than passing a blended ROAS off as exact.
 */
export function rollup(sections: PlatformInput[]): Rollup {
  const ok = sections.filter(
    (s): s is Extract<PlatformInput, { ok: true }> => s.ok,
  );
  const excluded = sections
    .filter((s): s is Extract<PlatformInput, { ok: false }> => !s.ok)
    .map((s) => ({ platform: s.platform, error: s.error }));

  const totals = ok.reduce(
    (acc, s) => {
      acc.spend += s.summary.spend;
      acc.impressions += s.summary.impressions;
      acc.clicks += s.summary.clicks;
      acc.purchases += s.summary.purchases;
      acc.revenue += s.summary.revenue;
      acc.trialStarts += s.summary.trialStarts;
      return acc;
    },
    { spend: 0, impressions: 0, clicks: 0, purchases: 0, revenue: 0, trialStarts: 0 },
  );

  const blended: Summary = {
    ...totals,
    roas: safeDiv(totals.revenue, totals.spend),
    cpa: safeDiv(totals.spend, totals.purchases),
    cpTrial: safeDiv(totals.spend, totals.trialStarts),
    ctr: safeDiv(totals.clicks, totals.impressions),
    cpm: safeDiv(totals.spend, totals.impressions) * 1000,
  };

  const networks: NetworkLine[] = ok
    .map((s) => ({
      platform: s.platform,
      attributionWindow: s.attributionWindow,
      summary: s.summary,
      spendShare: safeDiv(s.summary.spend, totals.spend),
    }))
    .sort((a, b) => b.summary.spend - a.summary.spend);

  return {
    blended,
    networks,
    excluded,
    complete: excluded.length === 0 && ok.length > 0,
    attributionWindows: [...new Set(ok.map((s) => s.attributionWindow))],
  };
}
