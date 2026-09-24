import type { CreativeMetrics, DateRange, Platform } from "../types.js";
import { fetchCreativeMetrics as fetchMeta } from "../adapters/meta.js";
import { fetchCreativeMetrics as fetchTikTok } from "../adapters/tiktok.js";
import { fetchCreativeMetrics as fetchPinterest } from "../adapters/pinterest.js";
import { fetchObservedRevenue, queryPostHog } from "../adapters/posthog.js";

/**
 * The weekly checkpoint's data layer.
 *
 * Everything here reuses the adapters the digest uses, deliberately: the point
 * of a repeatable checkpoint is that its numbers cannot drift from the numbers
 * in the daily post. Nothing in this file re-implements a metric.
 *
 * On maturity — the rule that matters most when reading the output. A
 * conversion cohort keeps maturing for roughly seven days, so the most recent
 * week always reads worse than it eventually will. Compare a fresh week against
 * what the previous week read AT THE SAME AGE, never against its matured value.
 * `daysMatured` on every week says how long it has had to settle.
 */

export type WeekRange = DateRange & { label: string; daysMatured: number };

/**
 * Monday-start weeks, most recent complete week last.
 *
 * PostHog's toStartOfWeek defaults to SUNDAY, so every query below passes mode
 * 1 to match these. Mixing the two shifts every figure by a day and is
 * invisible in the output.
 */
export function lastCompleteWeeks(count: number, today = new Date()): WeekRange[] {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow); // Monday of the current, incomplete week
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const out: WeekRange[] = [];
  for (let i = count; i >= 1; i--) {
    const start = new Date(d);
    start.setUTCDate(start.getUTCDate() - 7 * i);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    out.push({
      label: iso(start),
      start: iso(start),
      end: iso(end),
      daysMatured: Math.round((today.getTime() - end.getTime()) / 86_400_000),
    });
  }
  return out;
}

const sum = (rows: CreativeMetrics[], key: keyof CreativeMetrics): number =>
  rows.reduce((a, r) => a + (typeof r[key] === "number" ? (r[key] as number) : 0), 0);

export type NetworkWeek = {
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  claimedRevenue: number;
  observedNet: number;
};

export type SourceSplit = {
  spend: number;
  clicks: number;
  purchases: number;
  claimedRevenue: number;
};

export type CheckpointWeek = {
  week: WeekRange;
  networks: Partial<Record<Platform, NetworkWeek>>;
  /** Meta only, split on whether the campaign name marks the outside vendor.
   *  Campaign naming is the only marker this account carries — verified
   *  2026-09-24 that no ad or ad set inside an in-house campaign uses it. Ad
   *  names carry no creator tag, so this splits campaign ownership rather than
   *  strictly authorship. */
  metaBySource: { vendor: SourceSplit; inHouse: SourceSplit };
  coverage: number | undefined;
  errors: string[];
};

const VENDOR_RX = /percep/i;
const emptySplit = (): SourceSplit => ({
  spend: 0,
  clicks: 0,
  purchases: 0,
  claimedRevenue: 0,
});

async function pullPlatform(
  platform: Platform,
  range: DateRange,
): Promise<{ rows: CreativeMetrics[] } | { error: string }> {
  const fn = { meta: fetchMeta, tiktok: fetchTikTok, pinterest: fetchPinterest }[platform];
  try {
    return { rows: await fn(range) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function buildWeek(week: WeekRange): Promise<CheckpointWeek> {
  const range: DateRange = { start: week.start, end: week.end };
  const errors: string[] = [];
  const networks: Partial<Record<Platform, NetworkWeek>> = {};
  const metaBySource = { vendor: emptySplit(), inHouse: emptySplit() };

  // Platforms run in sequence, not in parallel: the Meta adapter refreshes its
  // access token at the top of every pull, and two concurrent refreshes would
  // race to write .env.
  for (const platform of ["meta", "tiktok", "pinterest"] as const) {
    const res = await pullPlatform(platform, range);
    if ("error" in res) {
      errors.push(`${platform}: ${res.error}`);
      continue;
    }
    networks[platform] = {
      spend: sum(res.rows, "spend"),
      impressions: sum(res.rows, "impressions"),
      clicks: sum(res.rows, "clicks"),
      purchases: sum(res.rows, "purchases"),
      claimedRevenue: sum(res.rows, "revenue"),
      observedNet: 0,
    };
    if (platform === "meta") {
      for (const r of res.rows) {
        const side = VENDOR_RX.test(r.campaignName) ? metaBySource.vendor : metaBySource.inHouse;
        side.spend += r.spend;
        side.clicks += r.clicks;
        side.purchases += r.purchases;
        side.claimedRevenue += r.revenue;
      }
    }
  }

  let coverage: number | undefined;
  try {
    const observed = await fetchObservedRevenue(range);
    if (observed) {
      for (const n of observed.networks) {
        const slot = networks[n.platform];
        if (slot) slot.observedNet = n.netRevenue;
      }
      coverage =
        observed.coverage.revenue > 0
          ? observed.coverage.joinableRevenue / observed.coverage.revenue
          : undefined;
    }
  } catch (err) {
    errors.push(`observed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { week, networks, metaBySource, coverage, errors };
}

/* ------------------------------------------------------------------ *
 * Funnel — the early-warning half
 * ------------------------------------------------------------------ */

export type FunnelWeek = {
  week: string;
  newCustomers: number;
  paidVisitors: number;
  paidSignupDone: number;
  paidPlanSelect: number;
  paidConverted: number;
  planSelects: number;
  nonTrialToPaid: number;
  freeTrialShare: number;
  completeLoginPct: number;
};

/** The web funnel: paid traffic lands here and the paywall lives here. Price is
 *  displayed nowhere else, which is why a drop-off above plan_select cannot be
 *  a pricing problem. `www.natal.app` carries no paywall and must never be
 *  treated as a conversion surface. */
const FUNNEL_HOST = "join.natal.app";
const NEW_MONEY = "'rc_initial_purchase_event','rc_trial_converted_event'";
const HAS_CLICK_ID =
  "(properties.fbclid IS NOT NULL OR properties.ttclid IS NOT NULL OR properties.epik IS NOT NULL)";

export async function fetchFunnel(weeks: WeekRange[]): Promise<FunnelWeek[]> {
  const first = weeks[0];
  const last = weeks[weeks.length - 1];
  if (!first || !last) return [];

  const from = `toDateTime('${first.start} 00:00:00')`;
  const endExclusive = new Date(`${last.end}T00:00:00Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  const to = `toDateTime('${endExclusive.toISOString().slice(0, 10)} 00:00:00')`;
  const wk = (col: string) => `formatDateTime(toStartOfWeek(${col}, 1),'%Y-%m-%d')`;

  // Sequentially, with a retry: PostHog answers 503 "queries are a little too
  // busy" when four of these land at once, and 504 when one runs long. Both are
  // transient and both would otherwise lose the whole funnel section.
  const run = async (query: string): Promise<unknown[]> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await queryPostHog(query);
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (!/50[34]|too busy|max execution/i.test(msg)) throw err;
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      }
    }
    throw lastErr;
  };

  const customersQ = `
      SELECT ${wk("timestamp")} AS wk, count() AS n
      FROM events WHERE event IN (${NEW_MONEY}) AND timestamp >= ${from} AND timestamp < ${to}
      GROUP BY wk ORDER BY wk LIMIT 500`;

  const funnelQ = `
      WITH v AS (
        SELECT person_id, ${wk("min(timestamp)")} AS wk
        FROM events WHERE event='$pageview' AND timestamp >= ${from} AND timestamp < ${to} AND ${HAS_CLICK_ID}
        GROUP BY person_id
        HAVING argMin(coalesce(properties.$host,'?'), timestamp) = '${FUNNEL_HOST}'
      ),
      st AS (
        -- Restricted to the visitor set. Without it this scans every signup and
        -- purchase in the window before joining to a few thousand people, and
        -- PostHog answers 504. Same failure the observed-revenue query had.
        SELECT person_id, event FROM events
        WHERE event IN ('sign_up_complete','plan_select',${NEW_MONEY}) AND timestamp >= ${from}
          AND person_id IN (SELECT person_id FROM v)
        GROUP BY person_id, event
      )
      SELECT wk, count() AS visitors,
        countIf(person_id IN (SELECT person_id FROM st WHERE event='sign_up_complete')) AS signup_done,
        countIf(person_id IN (SELECT person_id FROM st WHERE event='plan_select')) AS plan_select,
        countIf(person_id IN (SELECT person_id FROM st WHERE event IN (${NEW_MONEY}))) AS converted
      FROM v GROUP BY wk ORDER BY wk LIMIT 500`;

  const paywallQ = `
      WITH sel AS (
        SELECT person_id, min(timestamp) AS t,
               argMin(JSONExtractString(properties,'product_id'), timestamp) AS pid
        FROM events WHERE event='plan_select' AND timestamp >= ${from} AND timestamp < ${to}
          AND JSONExtractString(properties,'product_id') != ''
        GROUP BY person_id
      ),
      paid AS (
        SELECT DISTINCT person_id FROM events
        WHERE event IN (${NEW_MONEY}) AND timestamp >= ${from}
          AND person_id IN (SELECT person_id FROM sel)
      )
      SELECT ${wk("t")} AS wk, count() AS plan_selects,
        round(countIf(pid NOT LIKE '%trial%' AND person_id IN (SELECT person_id FROM paid))
              / nullIf(countIf(pid NOT LIKE '%trial%'), 0) * 100, 1) AS nontrial_to_paid,
        round(countIf(pid LIKE '%free_trial%' OR pid LIKE '%days_trial%') / count() * 100, 1) AS free_trial_share
      FROM sel GROUP BY wk ORDER BY wk LIMIT 500`;

  const afterSignupQ = `
      WITH su AS (
        SELECT person_id, min(timestamp) AS t, ${wk("min(timestamp)")} AS wk
        FROM events WHERE event='sign_up_complete' AND timestamp >= ${from} AND timestamp < ${to}
        GROUP BY person_id
      ),
      nx AS (
        SELECT s.person_id AS person_id, s.wk AS wk, argMin(e.event, e.timestamp) AS nxt
        FROM su s INNER JOIN events e ON e.person_id = s.person_id
        WHERE e.timestamp > s.t AND e.timestamp < s.t + INTERVAL 2 HOUR
          AND e.event NOT IN ('$pageleave','$web_vitals','$autocapture','$set','$identify','$feature_flag_called')
        GROUP BY s.person_id, s.wk
      )
      SELECT wk, round(countIf(nxt='complete_login') / count() * 100, 1) AS pct
      FROM nx GROUP BY wk ORDER BY wk LIMIT 500`;
  const customers = await run(customersQ);
  const funnel = await run(funnelQ);
  const paywall = await run(paywallQ);
  const afterSignup = await run(afterSignupQ);


  const index = (rows: unknown[]) =>
    new Map((rows as unknown[][]).map((r) => [String(r[0]), r] as const));
  const c = index(customers);
  const f = index(funnel);
  const p = index(paywall);
  const a = index(afterSignup);
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  return weeks.map((w) => {
    const fr = f.get(w.label);
    const pr = p.get(w.label);
    return {
      week: w.label,
      newCustomers: num(c.get(w.label)?.[1]),
      paidVisitors: num(fr?.[1]),
      paidSignupDone: num(fr?.[2]),
      paidPlanSelect: num(fr?.[3]),
      paidConverted: num(fr?.[4]),
      planSelects: num(pr?.[1]),
      nonTrialToPaid: num(pr?.[2]),
      freeTrialShare: num(pr?.[3]),
      completeLoginPct: num(a.get(w.label)?.[1]),
    };
  });
}
