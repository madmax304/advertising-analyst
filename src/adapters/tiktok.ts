import type { CreativeMetrics, DateRange } from "../types.js";
import { EVENT_MAP } from "../events/eventMap.js";

const TIKTOK_API = "https://business-api.tiktok.com/open_api/v1.3";
const ATTRIBUTION_LABEL = "7-day click / 1-day view";

export type CreativeEnrichment = {
  thumbnailUrl?: string;
  previewUrl?: string;
  adName?: string; // override caption-based name with the real ad name from /ad/get/
};

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

type TikTokAdMeta = {
  ad_id: string;
  ad_name?: string;
  video_id?: string | null;
  tiktok_item_id?: string | null;
};

/**
 * For top-ranked TikTok ads, look up creative metadata. Two ad shapes
 * to handle (verified against Natal's account 2026-04-24):
 *
 * 1. **Upload ads** — have a `video_id`. Real ad_name is filename-style
 *    ("Video Apr 17 2026, 2 13 10 PM_zBfMWNZQ.mp4"). Thumbnail comes from
 *    /file/video/ad/info/ → video_cover_url. No public preview URL.
 *
 * 2. **Spark Ads** — have a `tiktok_item_id` (the original organic post).
 *    No video_id. ad_name is the caption (TikTok auto-fills). Thumbnail
 *    + public preview URL come from TikTok's public oEmbed endpoint
 *    (no auth required). Public URL: tiktok.com/@username/video/{item_id}.
 *
 * Needs: Ads Management→Ad scope (for /ad/get/) and Creative Management
 * scope (for /file/video/ad/info/). Spark Ad lookup uses public oEmbed
 * so doesn't need any TikTok scope.
 */
export async function fetchThumbnails(
  adIds: string[],
): Promise<Record<string, CreativeEnrichment>> {
  if (adIds.length === 0) return {};
  const env = readEnv();

  // Step 1: /ad/get/ for ad_name, video_id, tiktok_item_id per ad
  const adsList = await fetchAdsMeta(env, adIds);

  const out: Record<string, CreativeEnrichment> = {};
  const videoIdToAdIds = new Map<string, string[]>();
  const itemIdToAdIds = new Map<string, string[]>();

  for (const ad of adsList) {
    out[ad.ad_id] = { adName: ad.ad_name };
    if (ad.video_id) {
      const list = videoIdToAdIds.get(ad.video_id) ?? [];
      list.push(ad.ad_id);
      videoIdToAdIds.set(ad.video_id, list);
    } else if (ad.tiktok_item_id) {
      const list = itemIdToAdIds.get(ad.tiktok_item_id) ?? [];
      list.push(ad.ad_id);
      itemIdToAdIds.set(ad.tiktok_item_id, list);
    }
  }

  // Step 2a: upload ads → /file/video/ad/info/ for video_cover_url
  if (videoIdToAdIds.size > 0) {
    const covers = await fetchVideoCovers(env, [...videoIdToAdIds.keys()]);
    for (const v of covers) {
      const ids = videoIdToAdIds.get(v.video_id) ?? [];
      for (const adId of ids) {
        out[adId] = { ...out[adId], thumbnailUrl: v.video_cover_url };
      }
    }
  }

  // Step 2b: Spark Ads → TikTok public oEmbed for thumbnail + preview URL
  // Sequential rather than parallel — oEmbed is a public service, don't hammer
  // it; Natal's top-3-by-spend + top-3-by-roas is at most 6 calls per platform.
  for (const [itemId, ids] of itemIdToAdIds) {
    const oembed = await fetchSparkAdOEmbed(itemId);
    if (!oembed) continue;
    for (const adId of ids) {
      out[adId] = {
        ...out[adId],
        thumbnailUrl: oembed.thumbnail_url,
        previewUrl: oembed.preview_url,
      };
    }
  }

  return out;
}

async function fetchAdsMeta(env: TikTokEnv, adIds: string[]): Promise<TikTokAdMeta[]> {
  const adFilter = encodeURIComponent(JSON.stringify({ ad_ids: adIds }));
  const adFields = encodeURIComponent(
    JSON.stringify(["ad_id", "ad_name", "video_id", "tiktok_item_id"]),
  );
  const url =
    `${TIKTOK_API}/ad/get/?advertiser_id=${env.advertiserId}` +
    `&filtering=${adFilter}&fields=${adFields}&page_size=100`;
  try {
    const res = await fetch(url, { headers: { "Access-Token": env.token } });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      code: number;
      message?: string;
      data?: { list?: TikTokAdMeta[] };
    };
    if (json.code !== 0) {
      console.error(`[tiktok] /ad/get/ code=${json.code}: ${json.message}`);
      return [];
    }
    return json.data?.list ?? [];
  } catch (err) {
    console.error(`[tiktok] /ad/get/ exception:`, err instanceof Error ? err.message : err);
    return [];
  }
}

async function fetchVideoCovers(
  env: TikTokEnv,
  videoIds: string[],
): Promise<{ video_id: string; video_cover_url?: string }[]> {
  const param = encodeURIComponent(JSON.stringify(videoIds));
  const url = `${TIKTOK_API}/file/video/ad/info/?advertiser_id=${env.advertiserId}&video_ids=${param}`;
  try {
    const res = await fetch(url, { headers: { "Access-Token": env.token } });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      code: number;
      message?: string;
      data?: { list?: { video_id: string; video_cover_url?: string }[] };
    };
    if (json.code !== 0) {
      console.error(
        `[tiktok] /file/video/ad/info/ code=${json.code}: ${json.message}`,
      );
      return [];
    }
    return json.data?.list ?? [];
  } catch (err) {
    console.error(
      `[tiktok] /file/video/ad/info/ exception:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * TikTok's public oEmbed endpoint. Takes any URL of shape
 * https://www.tiktok.com/@anyusername/video/{tiktok_item_id} and returns the
 * actual thumbnail + author handle, even if the username is wrong (TikTok
 * resolves by item_id internally). No auth required, no scope needed.
 */
async function fetchSparkAdOEmbed(
  itemId: string,
): Promise<{ thumbnail_url?: string; preview_url?: string } | null> {
  // Placeholder username — TikTok auto-corrects via item_id
  const target = `https://www.tiktok.com/@unknown/video/${itemId}`;
  const url = `https://www.tiktok.com/oembed?url=${encodeURIComponent(target)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      thumbnail_url?: string;
      author_unique_id?: string;
    };
    const handle = json.author_unique_id;
    return {
      thumbnail_url: json.thumbnail_url,
      preview_url: handle ? `https://www.tiktok.com/@${handle}/video/${itemId}` : undefined,
    };
  } catch (err) {
    console.error(
      `[tiktok] oEmbed lookup failed for item ${itemId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
