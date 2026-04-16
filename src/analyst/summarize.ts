import type { CreativeMetrics } from "../types.js";

export type Summary = {
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  revenue: number;
  trialStarts: number;
  roas: number; // revenue / spend; 0 if spend is 0
  cpa: number; // spend / purchases; 0 if purchases is 0
  cpTrial: number; // spend / trialStarts; 0 if trialStarts is 0
  ctr: number; // clicks / impressions (0-1); 0 if impressions is 0
  cpm: number; // spend / impressions * 1000; 0 if impressions is 0
};

function safeDiv(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export function summarize(metrics: CreativeMetrics[]): Summary {
  const totals = metrics.reduce(
    (acc, m) => {
      acc.spend += m.spend;
      acc.impressions += m.impressions;
      acc.clicks += m.clicks;
      acc.purchases += m.purchases;
      acc.revenue += m.revenue;
      acc.trialStarts += m.trialStarts;
      return acc;
    },
    { spend: 0, impressions: 0, clicks: 0, purchases: 0, revenue: 0, trialStarts: 0 },
  );

  return {
    ...totals,
    roas: safeDiv(totals.revenue, totals.spend),
    cpa: safeDiv(totals.spend, totals.purchases),
    cpTrial: safeDiv(totals.spend, totals.trialStarts),
    ctr: safeDiv(totals.clicks, totals.impressions),
    cpm: safeDiv(totals.spend, totals.impressions) * 1000,
  };
}
