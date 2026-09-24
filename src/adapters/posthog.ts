import type { DateRange, Platform } from "../types.js";

/**
 * Independently OBSERVED revenue, from PostHog.
 *
 * The other three adapters report what each network claims about itself. This
 * one reports what actually got booked, by joining RevenueCat's revenue events
 * (which land in PostHog via webhook) to the ad click that preceded them.
 *
 * Why this exists: RevenueCat holds every dollar but can only attribute Apple
 * Search Ads — its `$mediaSource` subscriber attribute is populated on 8.5% of
 * conversions and every populated value is "Apple Search Ads" (verified
 * 2026-09-10). Web conversions from Meta/TikTok/Pinterest carry no attribution
 * there. PostHog has both halves: click IDs on `$pageview`, revenue on `rc_*`.
 *
 * READ THIS BEFORE QUOTING THE OUTPUT — it is a FLOOR, not the truth:
 *  - Only ~40% of RC conversions join to any ad click. The rest are app installs
 *    (no web pageview), organic, cleared cookies, or cross-device journeys.
 *    Real ad-driven revenue is somewhere between this figure and the networks'.
 *  - Single-touch. Someone who clicked two networks is credited to the last one.
 *    Measured overlap is negligible (67 people of ~119K), so this is a rounding
 *    concern, not a live dispute.
 *  - Web-click only. A phone-to-desktop journey doesn't join.
 */

const NEW_MONEY_EVENTS = ["rc_initial_purchase_event", "rc_trial_converted_event"];
const RENEWAL_EVENT = "rc_renewal_event";

/** Apple and Google take 30%; Stripe/web ~5%. Applied per transaction from the
 *  event's own `store`, not as a blended rate — media skews web (RC_BILLING)
 *  while ASA skews App Store, so one blended multiplier would misstate both. */
const APP_STORES = ["APP_STORE", "PLAY_STORE"];

/** How far back to look for the click that earned a conversion. Deliberately
 *  wider than any network's own window: 43% of attributable revenue lands more
 *  than 7 days after the click, which Meta's 7-day window cannot see. */
const DEFAULT_LOOKBACK_DAYS = 90;

export type ObservedNetwork = {
  platform: Platform;
  /** Excludes renewals — the acquisition question, matching how the ASA work
   *  treats CPA. */
  conversions: number;
  grossRevenue: number;
  netRevenue: number;
  /** Same window including renewal revenue, for cash-flow context. */
  conversionsInclRenewals: number;
  grossInclRenewals: number;
  netInclRenewals: number;
};

export type ObservedAttribution = {
  networks: ObservedNetwork[];
  lookbackDays: number;
  /** What share of booked revenue we can attribute at all. */
  coverage: {
    conversions: number;
    joinableConversions: number;
    revenue: number;
    joinableRevenue: number;
  };
};

type PostHogEnv = { host: string; projectId: string; apiKey: string };

function readEnv(): PostHogEnv | undefined {
  const host = process.env.POSTHOG_HOST?.replace(/\/$/, "");
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const apiKey = process.env.POSTHOG_API_KEY;
  // Absent config is not an error — the digest just renders claimed-only.
  if (!host || !projectId || !apiKey) return undefined;
  return { host, projectId, apiKey };
}

async function hogql<T = unknown[]>(env: PostHogEnv, query: string): Promise<T[]> {
  const res = await fetch(`${env.host}/api/projects/${env.projectId}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  const body = (await res.json()) as { results?: T[]; detail?: string; error?: string };
  if (!res.ok || body.detail || body.error) {
    throw new Error(
      `PostHog query failed ${res.status}: ${(body.detail ?? body.error ?? "").slice(0, 300)}`,
    );
  }
  return body.results ?? [];
}

/** SQL literal for a date at midnight. Range ends are INCLUSIVE dates, so the
 *  exclusive upper bound is the day after. */
const dayStart = (isoDate: string): string => `toDateTime('${isoDate} 00:00:00')`;
function dayAfter(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return dayStart(d.toISOString().slice(0, 10));
}
function daysBefore(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return dayStart(d.toISOString().slice(0, 10));
}

/**
 * The click side. A person's network is decided by which click ID their
 * pageview carried — not by utm_source, which is unusable here: `meta`, `ig`,
 * `instagram` and `fb` are four spellings of one network, and `Pinterest` and
 * `pinterest` differ only by case.
 */
const CLICK_ID_CASE = `multiIf(
        properties.fbclid IS NOT NULL, 'meta',
        properties.ttclid IS NOT NULL, 'tiktok',
        properties.epik   IS NOT NULL, 'pinterest',
        '')`;
const HAS_CLICK_ID = `(properties.fbclid IS NOT NULL OR properties.ttclid IS NOT NULL OR properties.epik IS NOT NULL)`;

const REVENUE = `toFloatOrZero(JSONExtractString(properties,'revenue'))`;
const NET_MULTIPLIER = `if(JSONExtractString(properties,'store') IN (${APP_STORES.map((s) => `'${s}'`).join(",")}), 0.70, 0.95)`;
const ALL_REVENUE_EVENTS = [...NEW_MONEY_EVENTS, RENEWAL_EVENT].map((e) => `'${e}'`).join(",");

export async function fetchObservedRevenue(
  range: DateRange,
  lookbackDays: number = DEFAULT_LOOKBACK_DAYS,
): Promise<ObservedAttribution | undefined> {
  const env = readEnv();
  if (!env) return undefined;

  const from = dayStart(range.start);
  const to = dayAfter(range.end);
  const lookback = daysBefore(range.start, lookbackDays);

  // Last touch: for each conversion, the most recent qualifying click at or
  // before it. argMax over the joined clicks does the "most recent" part.
  const attribution = `
WITH conv AS (
  SELECT uuid AS conv_id, person_id, timestamp AS conv_ts,
         ${REVENUE} AS rev, ${NET_MULTIPLIER} AS mult,
         if(event = '${RENEWAL_EVENT}', 0, 1) AS is_new
  FROM events
  WHERE event IN (${ALL_REVENUE_EVENTS}) AND timestamp >= ${from} AND timestamp < ${to}
),
clk AS (
  -- Restricted to people who actually converted in-window. Without this the
  -- scan covers every click-tagged pageview in the lookback (hundreds of
  -- thousands of people) and the query began timing out at 504 as the dataset
  -- grew — the digest silently lost this section for days before anyone noticed.
  SELECT person_id, timestamp AS click_ts, ${CLICK_ID_CASE} AS network
  FROM events
  WHERE event = '$pageview' AND timestamp >= ${lookback} AND timestamp < ${to} AND ${HAS_CLICK_ID}
    AND person_id IN (SELECT person_id FROM conv)
)
SELECT network,
       countIf(is_new = 1) AS conv_new,
       sumIf(rev, is_new = 1) AS gross_new,
       sumIf(rev * mult, is_new = 1) AS net_new,
       count() AS conv_all,
       sum(rev) AS gross_all,
       sum(rev * mult) AS net_all
FROM (
  SELECT c.conv_id AS conv_id, any(c.rev) AS rev, any(c.mult) AS mult,
         any(c.is_new) AS is_new, argMax(k.network, k.click_ts) AS network
  FROM conv c INNER JOIN clk k ON c.person_id = k.person_id
  WHERE k.click_ts <= c.conv_ts
  GROUP BY c.conv_id
)
WHERE network != ''
GROUP BY network`;

  // Coverage: how much of the booked revenue we can attribute at all. Without
  // this the output looks authoritative when it's really a partial view.
  //
  // Measured on NEW MONEY ONLY, matching what the reported figure shows. An
  // earlier version counted renewals in this denominator while the reported
  // figure excluded them, understating coverage (19% vs the correct 24% for
  // 2026-09-03..09) — renewals come from cohorts acquired long before any click
  // in the lookback, so they belong in neither side or both.
  const coverage = `
WITH newmoney AS (
  SELECT person_id, ${REVENUE} AS rev FROM events
  WHERE event IN (${NEW_MONEY_EVENTS.map((e) => `'${e}'`).join(",")})
    AND timestamp >= ${from} AND timestamp < ${to}
),
clicked AS (
  -- Same restriction as above, for the same reason.
  SELECT DISTINCT person_id FROM events
  WHERE event = '$pageview' AND timestamp >= ${lookback} AND timestamp < ${to} AND ${HAS_CLICK_ID}
    AND person_id IN (SELECT person_id FROM newmoney)
)
SELECT count() AS conversions,
       countIf(person_id IN (SELECT person_id FROM clicked)) AS joinable_conversions,
       sum(${REVENUE}) AS revenue,
       sumIf(${REVENUE}, person_id IN (SELECT person_id FROM clicked)) AS joinable_revenue
FROM events
WHERE event IN (${NEW_MONEY_EVENTS.map((e) => `'${e}'`).join(",")})
  AND timestamp >= ${from} AND timestamp < ${to}`;

  const [rows, cov] = await Promise.all([
    hogql<unknown[]>(env, attribution),
    hogql<unknown[]>(env, coverage),
  ]);

  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const networks: ObservedNetwork[] = rows
    .map((r) => ({
      platform: String(r[0]) as Platform,
      conversions: num(r[1]),
      grossRevenue: num(r[2]),
      netRevenue: num(r[3]),
      conversionsInclRenewals: num(r[4]),
      grossInclRenewals: num(r[5]),
      netInclRenewals: num(r[6]),
    }))
    .filter((n) => n.platform === "meta" || n.platform === "tiktok" || n.platform === "pinterest");

  const c = cov[0] ?? [];
  return {
    networks,
    lookbackDays,
    coverage: {
      conversions: num(c[0]),
      joinableConversions: num(c[1]),
      revenue: num(c[2]),
      joinableRevenue: num(c[3]),
    },
  };
}
