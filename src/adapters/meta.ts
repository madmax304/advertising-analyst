import type { CreativeMetrics, DateRange } from "../types.js";
import { EVENT_MAP, REVENUE_MAP } from "../events/eventMap.js";

const GRAPH_API = "https://graph.facebook.com/v20.0";
const ATTRIBUTION_LABEL = "7-day click";

export type CreativeEnrichment = {
  thumbnailUrl?: string;
  previewUrl?: string;
  adName?: string; // optional override (e.g. when reporting metric is caption-based)
};

type MetaAction = { action_type: string; value: string };
type MetaInsightRow = {
  date_start: string;
  ad_id: string;
  ad_name: string;
  campaign_id: string;
  campaign_name: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: MetaAction[];
  action_values?: MetaAction[];
  conversions?: MetaAction[];
  conversion_values?: MetaAction[];
};
type MetaResponse = {
  data: MetaInsightRow[];
  paging?: { next?: string };
};

type MetaEnv = { token: string; adAccount: string };

function readEnv(): MetaEnv {
  const token = process.env.META_ACCESS_TOKEN;
  const adAccount = process.env.META_AD_ACCOUNT_ID;
  if (!token) throw new Error("META_ACCESS_TOKEN not set");
  if (!adAccount) throw new Error("META_AD_ACCOUNT_ID not set");
  // Meta ad account IDs canonically start with "act_". Fix silently if missing.
  const normalized = adAccount.startsWith("act_") ? adAccount : `act_${adAccount}`;
  return { token, adAccount: normalized };
}

function sumAction(actions: MetaAction[] | undefined, types: readonly string[]): number {
  if (!actions || types.length === 0) return 0;
  // Prefer the first matching type (priority order). Don't double-count.
  for (const type of types) {
    const hit = actions.find((a) => a.action_type === type);
    if (hit) {
      const n = Number(hit.value);
      return Number.isFinite(n) ? n : 0;
    }
  }
  return 0;
}

function toNum(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function fetchCreativeMetrics(range: DateRange): Promise<CreativeMetrics[]> {
  const env = readEnv();

  const params = new URLSearchParams({
    access_token: env.token,
    level: "ad",
    time_range: JSON.stringify({ since: range.start, until: range.end }),
    time_increment: "1",
    fields: [
      "ad_id",
      "ad_name",
      "campaign_id",
      "campaign_name",
      "spend",
      "impressions",
      "clicks",
      "actions",
      "action_values",
      "conversions", // StartTrial/Subscribe live here, not in actions
      "conversion_values",
      "date_start",
    ].join(","),
    action_attribution_windows: JSON.stringify(["7d_click"]),
    limit: "500",
  });

  let url: string | undefined = `${GRAPH_API}/${env.adAccount}/insights?${params.toString()}`;
  const allRows: MetaInsightRow[] = [];

  while (url) {
    const res: Response = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Meta insights ${res.status}: ${body.slice(0, 400)}`);
    }
    const page = (await res.json()) as MetaResponse;
    allRows.push(...page.data);
    url = page.paging?.next;
  }

  return allRows.map((row): CreativeMetrics => ({
    date: row.date_start,
    platform: "meta",
    attributionWindow: ATTRIBUTION_LABEL,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    adId: row.ad_id,
    adName: row.ad_name,
    creativeId: row.ad_id, // Meta creative_id requires a second call; ad_id is stable for ranking
    spend: toNum(row.spend),
    impressions: toNum(row.impressions),
    clicks: toNum(row.clicks),
    // Purchase lives in `actions`; StartTrial lives in `conversions`.
    // See src/events/eventMap.ts for the why.
    purchases: sumAction(row.actions, EVENT_MAP.purchase.meta),
    revenue: sumAction(row.action_values, REVENUE_MAP.purchase.meta),
    trialStarts: sumAction(row.conversions, EVENT_MAP.trial_start.meta),
  }));
}

/**
 * Given a list of ad IDs, fetch creative info (thumbnail URL and a preview
 * link) for each. Batch call — one request for up to ~50 IDs.
 * Called by the CLI only for top-ranked creatives to avoid N+1 per-ad calls.
 */
export async function fetchThumbnails(
  adIds: string[],
): Promise<Record<string, CreativeEnrichment>> {
  if (adIds.length === 0) return {};
  const env = readEnv();

  const params = new URLSearchParams({
    access_token: env.token,
    ids: adIds.join(","),
    fields:
      "creative{thumbnail_url,image_url,instagram_permalink_url,effective_object_story_id}",
  });

  const res = await fetch(`${GRAPH_API}/?${params.toString()}`);
  if (!res.ok) {
    // Non-fatal — thumbnails are enrichment. Log and fall back to no thumbs.
    const body = await res.text();
    console.error(`[meta] thumbnail fetch failed ${res.status}: ${body.slice(0, 200)}`);
    return {};
  }

  const data = (await res.json()) as Record<
    string,
    {
      creative?: {
        thumbnail_url?: string;
        image_url?: string;
        instagram_permalink_url?: string;
        effective_object_story_id?: string;
      };
    }
  >;

  const out: Record<string, CreativeEnrichment> = {};
  for (const [id, info] of Object.entries(data)) {
    const c = info.creative ?? {};
    // Preview URL priority:
    // 1. instagram_permalink_url — public IG post, works with no login
    // 2. effective_object_story_id → construct public FB post URL
    // We avoid preview_shareable_link (fb.me/...) because it redirects to
    // Business Manager login and produces a dead-end spinner in Chrome.
    const igUrl = c.instagram_permalink_url;
    const fbStoryId = c.effective_object_story_id;
    const previewUrl = igUrl ?? (fbStoryId ? `https://www.facebook.com/${fbStoryId}` : undefined);
    out[id] = {
      thumbnailUrl: c.thumbnail_url ?? c.image_url,
      previewUrl,
    };
  }
  return out;
}
