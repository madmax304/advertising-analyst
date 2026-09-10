import type { Platform } from "../types.js";

/**
 * Canonical metric → per-platform native field. The single source of truth for
 * everything the adapters read, including base metrics and revenue.
 *
 * Read this before comparing any number across networks. The three platforms
 * do NOT mean the same thing by "click", "purchase" or "revenue", and the whole
 * point of this file is to make those differences explicit rather than letting
 * them hide inside three adapters.
 *
 * Rules:
 *  - Adapters MUST resolve every field through this module. No column names or
 *    unit conversions hardcoded in adapter code — that's how `pinterest.ts` ended
 *    up silently reading a different revenue column than this file advertised.
 *  - Every spec carries a `means` string. If you can't write what a field
 *    actually counts, you don't yet know whether it's comparable.
 */

export type CanonicalEvent = "purchase" | "trial_start";

/** Which array in Meta's insights response a field lives in. `actions` is broad
 *  (includes link clicks etc.); `conversions` is the narrower attributed list.
 *  StartTrial/Subscribe appear only in `conversions`. */
export type MetaContainer = "actions" | "conversions" | "action_values" | "conversion_values";

/** How a raw platform value becomes the normalized unit we store (USD, counts). */
export type Transform =
  | { kind: "as_is" }
  /** Value arrives in millionths of a dollar (Pinterest revenue columns). */
  | { kind: "micro_dollars" }
  /** Value is per-unit; multiply by the named metric to get the total. */
  | { kind: "multiply_by"; metric: string };

export type FieldSpec = {
  /** Column / metric / action_type name. An array is a priority list for Meta:
   *  first match wins, so the same logical event exposed under several
   *  action_types isn't double-counted. */
  field: string | string[];
  /** Meta only — which response array to look in. */
  container?: MetaContainer;
  /** Defaults to as_is. */
  transform?: Transform;
  /** What this field actually counts. Required. */
  means: string;
};

/* ------------------------------------------------------------------ *
 * Base metrics
 * ------------------------------------------------------------------ */

export type BaseMetric = "spend" | "impressions" | "clicks";

export const METRIC_MAP: Record<BaseMetric, Record<Platform, FieldSpec>> = {
  spend: {
    meta: { field: "spend", means: "Amount spent, USD" },
    tiktok: { field: "spend", means: "Amount spent, USD" },
    pinterest: { field: "SPEND_IN_DOLLAR", means: "Amount spent, USD" },
  },
  impressions: {
    meta: { field: "impressions", means: "Paid impressions" },
    tiktok: { field: "impressions", means: "Paid impressions" },
    pinterest: { field: "IMPRESSION_1", means: "Paid impressions (the _1 suffix is the paid variant)" },
  },
  clicks: {
    // DELIBERATE: inline_link_clicks, NOT `clicks`.
    //
    // Meta's `clicks` counts every click on the ad — likes, comments, shares,
    // photo expands, profile taps — not just clicks through to the site.
    // Measured 2026-09-10 over 2026-09-03..09: clicks 15,891 vs
    // inline_link_clicks 7,857. 50.6% of `clicks` never reached the site, so
    // reporting it alongside TikTok's and Pinterest's click-throughs inflated
    // Meta's CTR by ~2x (1.72% vs a true link CTR of 0.85%).
    meta: {
      field: "inline_link_clicks",
      means: "Clicks through to the destination (excludes social/expand clicks)",
    },
    tiktok: { field: "clicks", means: "Destination click-throughs" },
    pinterest: { field: "CLICKTHROUGH_1", means: "Paid destination click-throughs" },
  },
};

/* ------------------------------------------------------------------ *
 * Conversion events
 * ------------------------------------------------------------------ */

/**
 * Mapping source of truth — Maxwell's events tracking plan, 2026-04-16.
 *
 *   "Lead"              → actions["lead"]                       (sign_up_complete)
 *   "InitiateCheckout"  → actions["initiate_checkout"]          (plan_select)
 *   "StartTrial"        → conversions["start_trial_total"]      (payment_auth_complete)
 *   "Subscribe"         → conversions["subscribe_total"]        (rc_trial_converted; v2)
 *   "Purchase"          → actions["purchase" | "omni_purchase"] (rc_trial_converted / rc_renewal)
 *
 * Verified 2026-04-16 against act_414217401044850 (Natal): `start_trial_total`
 * returns 1,096 for 2026-04-01..2026-04-15 vs. 5.7K pixel fires in Events
 * Manager — consistent with ~20% ads-attributed.
 *
 * Natal plan mix: quarterly + annual include a free trial, monthly does NOT.
 * A day of heavy monthly signups can show Purchases ≥ Trials. Not a bug.
 */
export const EVENT_MAP: Record<CanonicalEvent, Record<Platform, FieldSpec>> = {
  purchase: {
    meta: {
      field: ["omni_purchase", "offsite_conversion.fb_pixel_purchase", "purchase"],
      container: "actions",
      means:
        "Purchases, web+app rollup. Per the tracking plan this includes " +
        "rc_trial_converted AND rc_renewal, so it is NOT purely new customers.",
    },
    tiktok: {
      field: "complete_payment",
      means:
        "Pixel e-commerce payment completions. Probe 2026-04-16: complete_payment=125 " +
        "vs total_purchase=5 for the same window — the conversion-tracking rollup " +
        "(total_purchase) is not in use here and returns 0, so complete_payment is the " +
        "only usable count. Includes renewals.",
    },
    pinterest: {
      field: "TOTAL_CHECKOUT",
      means: "Checkout conversions attributed within Pinterest's 30-day click window.",
    },
  },
  trial_start: {
    meta: {
      field: ["start_trial_total"],
      container: "conversions",
      means: "StartTrial. _total rolls up web+app; _website would be web-only.",
    },
    tiktok: {
      field: "total_start_trial",
      means:
        "KNOWN BROKEN: returns 0 at source — TikTok's trial tracking isn't firing " +
        "for this account. Do not use TikTok trials or Cost/Trial in comparisons.",
    },
    pinterest: {
      field: "TOTAL_SIGNUP",
      means:
        "Misleadingly named: Pinterest's 'signup' IS the trial-start event " +
        "(payment_auth_complete / rc_trial_started). Pinterest's 'lead' is what " +
        "catches account creation.",
    },
  },
};

/* ------------------------------------------------------------------ *
 * Revenue
 * ------------------------------------------------------------------ */

/**
 * Revenue per canonical event. `null` means the platform reports no revenue for
 * that event (trials don't carry revenue anywhere).
 *
 * IMPORTANT — all of this is PLATFORM-CLAIMED revenue, self-attributed by the
 * network that wants credit for it. It is not observed cash, it is not deduped
 * across networks, and summing it across platforms does not produce a real
 * number. RevenueCat holds the actual booked revenue but currently has no
 * attribution for these three networks (verified 2026-09-10: 93.9% of revenue
 * lands in RC's unattributed bucket; every attributed campaign is Apple Search
 * Ads). Treat these figures as each network's own scorecard.
 */
export const REVENUE_MAP: Record<CanonicalEvent, Record<Platform, FieldSpec | null>> = {
  purchase: {
    meta: {
      field: ["omni_purchase", "offsite_conversion.fb_pixel_purchase", "purchase"],
      container: "action_values",
      means: "Purchase conversion value, USD, as reported by the Meta pixel.",
    },
    tiktok: {
      // Was: spend × complete_payment_roas — circular, since we then computed
      // ROAS as revenue/spend and just handed TikTok's own number back.
      // value_per_complete_payment is a real currency figure (observed values
      // are clean plan prices: 119.99, 44.99, 29.99). Cross-checked 2026-09-10
      // over 2026-09-03..09: count×vpcp = $959.80 vs spend×roas = $959.85 —
      // agreeing, but the direct read avoids ROAS's 2dp rounding, which is
      // material per-creative on low spend.
      field: "value_per_complete_payment",
      transform: { kind: "multiply_by", metric: "complete_payment" },
      means: "Average value per completed payment × payment count, USD.",
    },
    pinterest: {
      field: "TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR",
      transform: { kind: "micro_dollars" },
      means: "Checkout conversion value. Pinterest reports millionths of a dollar.",
    },
  },
  trial_start: { meta: null, tiktok: null, pinterest: null },
};

/* ------------------------------------------------------------------ *
 * Attribution windows
 * ------------------------------------------------------------------ */

/**
 * These do NOT match, and that alone makes cross-network ROAS non-comparable:
 * a 30-day window catches conversions a 7-day window never sees, and a
 * view-through window credits people who never clicked.
 */
export const ATTRIBUTION: Record<
  Platform,
  { label: string; clickDays: number; viewDays: number }
> = {
  meta: { label: "7-day click", clickDays: 7, viewDays: 0 },
  tiktok: { label: "7-day click / 1-day view", clickDays: 7, viewDays: 1 },
  pinterest: { label: "30-day click", clickDays: 30, viewDays: 0 },
};

/** True when the platforms in `used` don't share one attribution window — i.e.
 *  any blended figure across them needs a caveat. */
export function attributionWindowsDiffer(used: Platform[]): boolean {
  const labels = new Set(used.map((p) => ATTRIBUTION[p].label));
  return labels.size > 1;
}

/* ------------------------------------------------------------------ *
 * Resolution helpers — adapters call these instead of reading fields directly
 * ------------------------------------------------------------------ */

const asNumber = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

function applyTransform(
  raw: number,
  spec: FieldSpec,
  flat: Record<string, unknown> | undefined,
): number {
  const t = spec.transform ?? { kind: "as_is" };
  switch (t.kind) {
    case "as_is":
      return raw;
    case "micro_dollars":
      return raw / 1_000_000;
    case "multiply_by":
      return raw * asNumber(flat?.[t.metric]);
  }
}

/** Resolve a spec against a flat metrics object (TikTok, Pinterest). */
export function resolveFlat(
  metrics: Record<string, unknown> | undefined,
  spec: FieldSpec | null,
): number {
  if (!spec || !metrics) return 0;
  const names = Array.isArray(spec.field) ? spec.field : [spec.field];
  for (const name of names) {
    if (metrics[name] !== undefined) {
      return applyTransform(asNumber(metrics[name]), spec, metrics);
    }
  }
  return 0;
}

export type MetaAction = { action_type: string; value: string };

/** Resolve a spec against Meta's action arrays, honouring the priority list so
 *  the same logical event isn't counted twice. */
export function resolveMetaAction(
  containers: Partial<Record<MetaContainer, MetaAction[] | undefined>>,
  spec: FieldSpec | null,
): number {
  if (!spec) return 0;
  const list = spec.container ? containers[spec.container] : undefined;
  if (!list) return 0;
  const names = Array.isArray(spec.field) ? spec.field : [spec.field];
  for (const name of names) {
    const hit = list.find((a) => a.action_type === name);
    if (hit) return applyTransform(asNumber(hit.value), spec, undefined);
  }
  return 0;
}

/** Every Meta insights field name this module needs requested. */
export function metaRequestFields(): string[] {
  return [
    METRIC_MAP.spend.meta.field as string,
    METRIC_MAP.impressions.meta.field as string,
    METRIC_MAP.clicks.meta.field as string,
  ];
}

/** Every TikTok / Pinterest metric name this module needs requested, including
 *  any metric referenced only by a multiply_by transform. */
export function requiredFlatFields(platform: "tiktok" | "pinterest"): string[] {
  const out = new Set<string>();
  const add = (spec: FieldSpec | null) => {
    if (!spec) return;
    for (const f of Array.isArray(spec.field) ? spec.field : [spec.field]) out.add(f);
    const t = spec.transform;
    if (t?.kind === "multiply_by") out.add(t.metric);
  };
  for (const m of Object.values(METRIC_MAP)) add(m[platform]);
  for (const e of Object.values(EVENT_MAP)) add(e[platform]);
  for (const r of Object.values(REVENUE_MAP)) add(r[platform]);
  return [...out];
}
