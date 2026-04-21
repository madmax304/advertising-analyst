import type { CreativeMetrics } from "../types.js";

export type RankedCreative = {
  adId: string;
  adName: string;
  spend: number;
  revenue: number;
  purchases: number;
  trialStarts: number;
  roas: number;
  // Populated post-ranking by adapter-specific enrichment (fetches image URLs
  // from the platform's creative / pin endpoints).
  thumbnailUrl?: string;
  previewUrl?: string;
};

export type RankBy = "roas" | "spend";

export type RankOptions = {
  by: RankBy;
  n?: number;
  minSpend?: number; // floor so a $2 spend creative can't win the board
  excludeAdIds?: Iterable<string>; // for deduping across multiple ranked lists
};

/**
 * Aggregates rows by adId, computes ROAS per creative, filters by minSpend,
 * optionally excludes specific ad IDs, and returns the top N sorted
 * descending by the requested metric.
 * Pure function, no I/O.
 */
export function rankCreatives(
  metrics: CreativeMetrics[],
  opts: RankOptions,
): RankedCreative[] {
  const { by, n = 3, minSpend = 50, excludeAdIds } = opts;
  const exclude = new Set(excludeAdIds ?? []);

  const byAd = new Map<string, RankedCreative>();
  for (const m of metrics) {
    if (exclude.has(m.adId)) continue;
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

  const withRoas = [...byAd.values()]
    .map((c) => ({ ...c, roas: c.spend > 0 ? c.revenue / c.spend : 0 }))
    .filter((c) => c.spend >= minSpend);

  const sorted =
    by === "spend"
      ? withRoas.sort((a, b) => b.spend - a.spend)
      : withRoas.sort((a, b) => b.roas - a.roas);

  return sorted.slice(0, n);
}
