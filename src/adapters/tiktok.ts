import type { CreativeMetrics, DateRange } from "../types.js";
import { EVENT_MAP } from "../events/eventMap.js";

const TIKTOK_API = "https://business-api.tiktok.com/open_api/v1.3";
const ATTRIBUTION_LABEL = "7-day click / 1-day view";

type TikTokRow = {
  dimensions: { ad_id: string; stat_time_day: string };
  metrics: Record<string, string | undefined>;
};

type TikTokReportResponse = {
  code: number;
  message: string;
  data?: {
    list?: TikTokRow[];
    page_info?: { page: number; total_page: number };
  };
};

type TikTokEnv = { token: string; advertiserId: string };

function readEnv(): TikTokEnv {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  const advertiserId = process.env.TIKTOK_ADVERTISER_ID;
  if (!token) throw new Error("TIKTOK_ACCESS_TOKEN not set");
  if (!advertiserId) throw new Error("TIKTOK_ADVERTISER_ID not set");
  return { token, advertiserId };
}

async function fetchReportPage(
  env: TikTokEnv,
  range: DateRange,
  page: number,
): Promise<TikTokReportResponse> {
  const params = new URLSearchParams({
    advertiser_id: env.advertiserId,
    report_type: "BASIC",
    data_level: "AUCTION_AD",
    // dimensions must be a JSON-encoded array per TikTok's spec
    dimensions: JSON.stringify(["ad_id", "stat_time_day"]),
    metrics: JSON.stringify([
      "spend",
      "impressions",
      "clicks",
      EVENT_MAP.purchase.tiktok, // "complete_payment"
      "complete_payment_roas",
      EVENT_MAP.trial_start.tiktok, // "total_start_trial"
      "ad_name",
      "campaign_id",
      "campaign_name",
    ]),
    start_date: range.start,
    end_date: range.end,
    page: String(page),
    page_size: "1000",
  });

  const res = await fetch(`${TIKTOK_API}/report/integrated/get/?${params.toString()}`, {
    headers: { "Access-Token": env.token },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`TikTok report HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  const json = (await res.json()) as TikTokReportResponse;
  // TikTok returns 200 with a non-zero code on logical errors (e.g. bad token).
  if (json.code !== 0) {
    throw new Error(`TikTok report code=${json.code}: ${json.message}`);
  }
  return json;
}

function toNum(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function fetchCreativeMetrics(range: DateRange): Promise<CreativeMetrics[]> {
  const env = readEnv();

  const firstPage = await fetchReportPage(env, range, 1);
  const rows: TikTokRow[] = [...(firstPage.data?.list ?? [])];
  const totalPages = firstPage.data?.page_info?.total_page ?? 1;
  for (let p = 2; p <= totalPages; p++) {
    const next = await fetchReportPage(env, range, p);
    rows.push(...(next.data?.list ?? []));
  }

  return rows.map((row): CreativeMetrics => {
    const { ad_id, stat_time_day } = row.dimensions;
    const m = row.metrics;
    const spend = toNum(m.spend);
    const purchases = toNum(m[EVENT_MAP.purchase.tiktok]);
    const trialStarts = toNum(m[EVENT_MAP.trial_start.tiktok]);
    // TikTok exposes ROAS directly; derive revenue = spend * ROAS so we keep
    // the same normalized shape as Meta/Pinterest.
    const roas = toNum(m.complete_payment_roas);
    const revenue = spend * roas;
    return {
      // `stat_time_day` comes back like "2026-04-15 00:00:00"; keep the YYYY-MM-DD head.
      date: stat_time_day.slice(0, 10),
      platform: "tiktok",
      attributionWindow: ATTRIBUTION_LABEL,
      campaignId: m.campaign_id ?? "",
      campaignName: m.campaign_name ?? "(unknown campaign)",
      adId: ad_id,
      adName: m.ad_name ?? `Ad ${ad_id}`,
      creativeId: ad_id,
      spend,
      impressions: toNum(m.impressions),
      clicks: toNum(m.clicks),
      purchases,
      revenue,
      trialStarts,
    };
  });
}
