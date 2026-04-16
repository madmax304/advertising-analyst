/**
 * Canonical event → per-platform native event name.
 *
 * Single source of truth for cross-platform event mapping. Adapters read from
 * here instead of hard-coding platform-specific event names. When your tracking
 * plan changes, update this file — no adapter code changes needed.
 *
 * Canonical event names are business-level ("trial_start", "purchase"), not
 * platform-specific. Values are the exact strings each platform's API returns.
 *
 * For Meta, the value is an `action_type` string (e.g. "lead", "omni_purchase").
 * For TikTok, it's the metric column name in a report response (e.g.
 * "complete_payment", "total_registration").
 * For Pinterest, it's a column name in the ads analytics response (e.g.
 * "TOTAL_CHECKOUT", "CONVERSIONS_SIGNUP").
 *
 * An array value means "sum these action types, in priority order: first match
 * wins." Meta in particular often exposes the same logical event under several
 * action_type strings (e.g. "lead" vs "offsite_conversion.fb_pixel_lead");
 * ordering lets you pick the canonical one without double-counting.
 */

export type CanonicalEvent = "purchase" | "trial_start";

export type EventMap = Record<
  CanonicalEvent,
  {
    meta: string[]; // action_type priority list; first found wins
    tiktok: string; // single metric name
    pinterest: string; // single column name
  }
>;

/**
 * Mapping source of truth — Maxwell's events tracking plan, 2026-04-16.
 *
 * Meta standard event names map to action_type strings in the Insights API.
 * IMPORTANT: some events live in `actions`, others in `conversions`. The two
 * fields overlap but aren't identical — `actions` is broader (includes link
 * clicks etc.), `conversions` is the narrower "attributed conversions" list.
 * StartTrial + Subscribe only show up in `conversions`, not `actions`.
 *
 *   "Lead"              → actions["lead"]                       (sign_up_complete)
 *   "InitiateCheckout"  → actions["initiate_checkout"]          (plan_select)
 *   "StartTrial"        → conversions["start_trial_total"]      (payment_auth_complete)
 *   "Subscribe"         → conversions["subscribe_total"]        (rc_trial_converted; v2)
 *   "Purchase"          → actions["purchase" | "omni_purchase"] (rc_trial_converted / rc_renewal)
 *
 * Verified 2026-04-16 against act_414217401044850 (Natal): `start_trial_total`
 * returns 1,096 for 2026-04-01..2026-04-15 vs. 5.7K pixel fires in Events
 * Manager — ratio is consistent with ~20% ads-attributed, reasonable.
 *
 * Natal subscription plan mix (2026-04-16): quarterly + annual plans include
 * a free trial, monthly plans do NOT. So a day with heavy monthly signups
 * can show Purchases ≥ Trials. Not a bug — it's the plan mix.
 *
 * TikTok + Pinterest: to be filled in during their walkthroughs.
 */
export const EVENT_MAP: EventMap = {
  purchase: {
    // omni_purchase aggregates web+app; pixel-only and plain "purchase" are
    // fallbacks. Lives in `actions`.
    meta: ["omni_purchase", "offsite_conversion.fb_pixel_purchase", "purchase"],
    // TikTok exposes two purchase metrics: `complete_payment` (pixel e-commerce
    // event, counts everything) and `total_purchase` (conversion-tracking
    // rollup, counts a subset). Probe on 2026-04-16 showed complete_payment=125
    // vs total_purchase=5 for same window — complete_payment captures the full
    // volume from rc_trial_converted + rc_initial_purchase + rc_renewal.
    tiktok: "complete_payment",
    pinterest: "TOTAL_CHECKOUT",
  },
  trial_start: {
    // Meta "StartTrial" → conversions["start_trial_total"].
    // "_total" rolls up web + app; "_website" is web-only. Prefer _total so
    // any future app tracking shows up without a code change.
    meta: ["start_trial_total"],
    // TikTok exposes both `start_trial` and `total_start_trial`; returned
    // equal (6 and 6) in 2026-04 probe. Using `total_start_trial` for
    // consistency with TikTok's convention of total_* being the aggregate.
    tiktok: "total_start_trial",
    // Pinterest's event naming is misleading: the event called "signup" is
    // actually the trial-start event, firing on payment_auth_complete /
    // rc_trial_started_event per Natal's tracking plan. Pinterest's "lead"
    // is what catches sign_up_complete (account creation, not trial start).
    // Verified via plan doc 2026-04-16; TOTAL_SIGNUP=42 over 15 days aligns
    // with Meta's StartTrial volume scaled by ad spend.
    pinterest: "TOTAL_SIGNUP",
  },
};

/**
 * Revenue field per canonical event. Same shape as EVENT_MAP but read from
 * `action_values` (Meta) / different metric (TikTok) / *_IN_DOLLAR column
 * (Pinterest). Trials don't typically carry revenue.
 */
export const REVENUE_MAP: EventMap = {
  purchase: {
    meta: ["omni_purchase", "offsite_conversion.fb_pixel_purchase", "purchase"],
    tiktok: "complete_payment_roas", // TikTok exposes ROAS; revenue = spend * roas
    pinterest: "TOTAL_CHECKOUT_VALUE_IN_DOLLAR",
  },
  trial_start: {
    meta: [],
    tiktok: "",
    pinterest: "",
  },
};
