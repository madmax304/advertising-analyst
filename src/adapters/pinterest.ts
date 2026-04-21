import type { CreativeMetrics, DateRange } from "../types.js";
import { EVENT_MAP } from "../events/eventMap.js";
import { PinterestAuthError, refreshAccessToken } from "./pinterestAuth.js";

const PINTEREST_API = "https://api.pinterest.com/v5";
const ATTRIBUTION_LABEL = "30-day click";

// Pinterest column names verified 2026-04-16 via a bogus-column probe against
// their Ads Analytics API. Event columns pulled from EVENT_MAP so a tracking
// plan change only needs a one-line edit in eventMap.ts.
// Note: revenue comes back in micro-dollars, divided to USD in the mapper.
const COLUMNS = [
  "SPEND_IN_DOLLAR",
  "IMPRESSION_1",
  "CLICKTHROUGH_1",
  EVENT_MAP.purchase.pinterest, // TOTAL_CHECKOUT
  EVENT_MAP.trial_start.pinterest, // TOTAL_SIGNUP
  "TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR",
] as const;

type AnalyticsRow = Record<string, unknown> & {
  AD_ID?: string | number;
  DATE?: string;
};

type AdMeta = { id: string; name: string; campaign_id: string; pin_id?: string };
type CampaignMeta = { id: string; name: string };

type PinterestEnv = { token: string; adAccount: string };

export type CreativeEnrichment = { thumbnailUrl?: string; previewUrl?: string };

// Module-level cache of adId → pin_id, populated by listAllAds during the main
// pull. Used by fetchThumbnails without re-hitting /ads.
let adIdToPinId: Record<string, string> = {};

function readEnv(): PinterestEnv {
  const token = process.env.PINTEREST_ACCESS_TOKEN;
  const adAccount = process.env.PINTEREST_AD_ACCOUNT_ID;
  if (!token) throw new Error("PINTEREST_ACCESS_TOKEN not set");
  if (!adAccount) throw new Error("PINTEREST_AD_ACCOUNT_ID not set");
  return { token, adAccount };
}

async function pinterestGet<T>(path: string, token: string, query: Record<string, string>): Promise<T> {
  const url = new URL(`${PINTEREST_API}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    // Token expired / revoked. The top-level caller catches this specific type
    // and refreshes + retries once.
    throw new PinterestAuthError(`Pinterest GET ${path} auth failed (401)`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Pinterest GET ${path} failed ${res.status}: ${body.slice(0, 400)}`);
  }
  return (await res.json()) as T;
}

async function listAllAds(env: PinterestEnv): Promise<AdMeta[]> {
  // /ad_accounts/{id}/ads returns everything in the account. We filter analytics
  // down to these ad_ids. Pagination via bookmark.
  // pin_id is included in the default response — we cache it for thumbnail lookup.
  const ads: AdMeta[] = [];
  let bookmark: string | undefined;
  do {
    const query: Record<string, string> = { page_size: "250" };
    if (bookmark) query.bookmark = bookmark;
    const page = await pinterestGet<{ items: AdMeta[]; bookmark?: string }>(
      `/ad_accounts/${env.adAccount}/ads`,
      env.token,
      query,
    );
    ads.push(...(page.items ?? []));
    bookmark = page.bookmark;
  } while (bookmark);

  // Refresh the cache for fetchThumbnails.
  adIdToPinId = {};
  for (const ad of ads) {
    if (ad.pin_id) adIdToPinId[ad.id] = ad.pin_id;
  }

  return ads;
}

async function fetchAnalytics(
  env: PinterestEnv,
  range: DateRange,
  adIds: string[],
): Promise<AnalyticsRow[]> {
  // /ad_accounts/{id}/ads/analytics requires an ad_ids filter.
  // Max 250 ads per call; paginate through the ad list in chunks.
  const all: AnalyticsRow[] = [];
  for (let i = 0; i < adIds.length; i += 250) {
    const batch = adIds.slice(i, i + 250);
    const rows = await pinterestGet<AnalyticsRow[] | { items?: AnalyticsRow[] }>(
      `/ad_accounts/${env.adAccount}/ads/analytics`,
      env.token,
      {
        start_date: range.start,
        end_date: range.end,
        granularity: "DAY",
        columns: COLUMNS.join(","),
        ad_ids: batch.join(","),
      },
    );
    const items = Array.isArray(rows) ? rows : (rows.items ?? []);
    all.push(...items);
  }
  return all;
}

async function fetchCampaignsMeta(
  env: PinterestEnv,
  campaignIds: string[],
): Promise<Record<string, CampaignMeta>> {
  const out: Record<string, CampaignMeta> = {};
  for (let i = 0; i < campaignIds.length; i += 250) {
    const batch = campaignIds.slice(i, i + 250);
    let bookmark: string | undefined;
    do {
      const query: Record<string, string> = {
        campaign_ids: batch.join(","),
        page_size: "250",
      };
      if (bookmark) query.bookmark = bookmark;
      const page = await pinterestGet<{ items: CampaignMeta[]; bookmark?: string }>(
        `/ad_accounts/${env.adAccount}/campaigns`,
        env.token,
        query,
      );
      for (const c of page.items ?? []) out[c.id] = c;
      bookmark = page.bookmark;
    } while (bookmark);
  }
  return out;
}

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export async function fetchCreativeMetrics(range: DateRange): Promise<CreativeMetrics[]> {
  // Pinterest "production" OAuth tokens expire in 30 days, but sometimes get
  // revoked earlier. On 401, refresh via the refresh_token and retry once.
  try {
    return await doFetchCreativeMetrics(range);
  } catch (err) {
    if (err instanceof PinterestAuthError) {
      console.error("[pinterest] access token rejected; refreshing and retrying once");
      await refreshAccessToken();
      return doFetchCreativeMetrics(range);
    }
    throw err;
  }
}

async function doFetchCreativeMetrics(range: DateRange): Promise<CreativeMetrics[]> {
  const env = readEnv();

  const ads = await listAllAds(env);
  if (ads.length === 0) return [];
  const adsMeta: Record<string, AdMeta> = Object.fromEntries(ads.map((a) => [a.id, a]));
  const adIds = ads.map((a) => a.id);

  const analytics = await fetchAnalytics(env, range, adIds);
  if (analytics.length === 0) return [];

  const campaignIds = [...new Set(Object.values(adsMeta).map((a) => a.campaign_id))];
  const campaignsMeta = await fetchCampaignsMeta(env, campaignIds);

  return analytics.map((row): CreativeMetrics => {
    const adId = String(row.AD_ID ?? "");
    const meta = adsMeta[adId];
    const campaign = meta ? campaignsMeta[meta.campaign_id] : undefined;
    return {
      date: row.DATE ?? range.start,
      platform: "pinterest",
      attributionWindow: ATTRIBUTION_LABEL,
      campaignId: meta?.campaign_id ?? "",
      campaignName: campaign?.name ?? "(unknown campaign)",
      adId,
      adName: meta?.name ?? `Ad ${adId}`,
      creativeId: adId, // Pinterest: the ad and creative are effectively 1:1 at this granularity
      spend: toNum(row.SPEND_IN_DOLLAR),
      impressions: toNum(row.IMPRESSION_1),
      clicks: toNum(row.CLICKTHROUGH_1),
      purchases: toNum(row[EVENT_MAP.purchase.pinterest]),
      // Pinterest returns revenue in micro-dollars (millionths of a USD).
      revenue: toNum(row.TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR) / 1_000_000,
      trialStarts: toNum(row[EVENT_MAP.trial_start.pinterest]),
    };
  });
}

/**
 * For the given ad IDs, fetch the underlying Pinterest pin's image URL.
 * Uses adIdToPinId populated during listAllAds — so this must be called
 * AFTER fetchCreativeMetrics has run in the same process.
 * Non-fatal on errors: returns empty for ads we can't enrich.
 */
export async function fetchThumbnails(
  adIds: string[],
): Promise<Record<string, CreativeEnrichment>> {
  if (adIds.length === 0) return {};

  const token = process.env.PINTEREST_ACCESS_TOKEN;
  const adAccount = process.env.PINTEREST_AD_ACCOUNT_ID;
  if (!token || !adAccount) return {};

  const out: Record<string, CreativeEnrichment> = {};

  for (const adId of adIds) {
    const pinId = adIdToPinId[adId];
    if (!pinId) continue;
    try {
      const pin = await pinterestGet<{
        id: string;
        media?: { images?: Record<string, { url: string; width?: number; height?: number }> };
      }>(`/pins/${pinId}`, token, { ad_account_id: adAccount });

      // Pinterest returns multiple image sizes. Prefer medium-ish (600x, 400x)
      // over originals — Slack renders thumbnails ~75px anyway.
      const images = pin.media?.images ?? {};
      const preferredSize =
        images["600x"]?.url ?? images["400x300"]?.url ?? images["236x"]?.url ?? images["originals"]?.url;

      out[adId] = {
        thumbnailUrl: preferredSize,
        previewUrl: `https://www.pinterest.com/pin/${pinId}/`,
      };
    } catch (err) {
      console.error(
        `[pinterest] thumbnail fetch failed for ad ${adId} (pin ${pinId}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return out;
}
