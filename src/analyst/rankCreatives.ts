import type { CreativeMetrics } from "../types.js";

export type RankedCreative = {
  adId: string;
  adName: string;
  spend: number;
  revenue: number;
  purchases: number;
  trialStarts: number;
  roas: number;
};

export type RankOptions = {
  by?: "roas"; // room to grow (e.g. "cpa"), but v1 is ROAS-only
  n?: number;
  minSpend?: number; // floor so a $2 spend creative can't win the board
};

/**
 * Aggregates rows by adId, computes ROAS per creative, filters by minSpend,
 * and returns the top N sorted descending by ROAS.
 * Pure function, no I/O.
 */
export function rankCreatives(
  metrics: CreativeMetrics[],
  opts: RankOptions = {},
): RankedCreative[] {
  const { n = 3, minSpend = 50 } = opts;

  const byAd = new Map<string, RankedCreative>();
  for (const m of metrics) {
    const existing = byAd.get(m.adId);
    if (existing) {
      existing.spend += m.spend;
      existing.revenue += m.revenue;
      existing.purchases += m.purchases;
      existing.trialStarts += m.trialStarts;
    } else {
      byAd.set(m.adId, {
        adId: m.adId,
        adName: m.adName,
        spend: m.spend,
        revenue: m.revenue,
        purchases: m.purchases,
        trialStarts: m.trialStarts,
        roas: 0,
      });
    }
  }

  const ranked = [...byAd.values()]
    .map((c) => ({ ...c, roas: c.spend > 0 ? c.revenue / c.spend : 0 }))
    .filter((c) => c.spend >= minSpend)
    .sort((a, b) => b.roas - a.roas);

  return ranked.slice(0, n);
}
