export type Platform = "meta" | "tiktok" | "pinterest";

export type CreativeMetrics = {
  date: string; // YYYY-MM-DD
  platform: Platform;
  attributionWindow: string; // e.g. "7-day click"
  campaignId: string;
  campaignName: string;
  adId: string;
  adName: string;
  creativeId: string;
  spend: number; // USD
  impressions: number;
  clicks: number;
  purchases: number;
  revenue: number; // from purchase events, USD
  trialStarts: number;
};

export type DateRange = {
  start: string; // YYYY-MM-DD inclusive
  end: string; // YYYY-MM-DD inclusive
};

export type AdapterResult =
  | { ok: true; platform: Platform; attributionWindow: string; rows: CreativeMetrics[] }
  | { ok: false; platform: Platform; error: string };
