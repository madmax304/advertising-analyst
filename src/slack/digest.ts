import { IncomingWebhook } from "@slack/webhook";
import type { Platform, DateRange } from "../types.js";
import type { Summary } from "../analyst/summarize.js";
import type { RankedCreative } from "../analyst/rankCreatives.js";
import { rollup } from "../analyst/rollup.js";
import type { ObservedAttribution } from "../adapters/posthog.js";

export type PlatformSection =
  | {
      ok: true;
      platform: Platform;
      attributionWindow: string;
      summary: Summary;
      topBySpend: RankedCreative[];
      topByRoas: RankedCreative[]; // deduped against topBySpend
      spendFloor: number; // USD minimum for topBySpend, shown in the digest header
      roasFloor: number; // USD minimum for topByRoas
    }
  | {
      ok: false;
      platform: Platform;
      error: string;
    };

type SlackBlock = Record<string, unknown>;

const PLATFORM_LABEL: Record<Platform, string> = {
  meta: "Meta",
  tiktok: "TikTok",
  pinterest: "Pinterest",
};

const usd = (n: number): string =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const num = (n: number): string => n.toLocaleString("en-US");
const ratio = (n: number): string => n.toFixed(2);
const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;
const plural = (n: number, singular: string): string =>
  `${num(n)} ${singular}${n === 1 ? "" : "s"}`;
// For rate metrics that divide-by-zero (Cost/Trial when trials=0): render "—"
// instead of $0 so the reader isn't told zero dollars bought zero trials.
const usdOrDash = (n: number): string => (n > 0 ? usd(n) : "—");

// Condense big counts so "1,234,567 impressions" renders as "1.2M"
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

// TikTok (and sometimes Meta) advertisers use the ad's caption as its name,
// which blows up the digest. Cap at 60 chars so each line stays scannable.
const MAX_AD_NAME_CHARS = 60;
function truncateAdName(name: string): string {
  if (name.length <= MAX_AD_NAME_CHARS) return name;
  return `${name.slice(0, MAX_AD_NAME_CHARS - 1).trimEnd()}…`;
}

function creativeBlock(c: RankedCreative, rank: number): SlackBlock {
  const name = truncateAdName(c.adName);
  // If we have a previewUrl, linkify the name so clicks open the ad.
  const nameText = c.previewUrl ? `<${c.previewUrl}|${name}>` : name;
  // Purchases before trials, matching the order in the totals lines above so
  // the eye reads the same sequence at both altitudes. Per EVENT_MAP, purchases
  // include renewals on Meta and TikTok — a high count here is not necessarily
  // new customers.
  const body =
    `*${rank}.* ${nameText}\n` +
    `ROAS *${ratio(c.roas)}*, Spend ${usd(c.spend)}, ` +
    `${plural(c.purchases, "purchase")}, ${plural(c.trialStarts, "trial")}`;

  const block: SlackBlock = {
    type: "section",
    text: { type: "mrkdwn", text: body },
  };
  if (c.thumbnailUrl) {
    block.accessory = {
      type: "image",
      image_url: c.thumbnailUrl,
      alt_text: name,
    };
  }
  return block;
}

function sectionBlocks(section: PlatformSection): SlackBlock[] {
  const label = PLATFORM_LABEL[section.platform];

  if (!section.ok) {
    return [
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*── ${label} ──*\n:warning: _Pull failed: ${section.error}_`,
        },
      },
    ];
  }

  const { summary, topBySpend, topByRoas, attributionWindow } = section;
  // Two-line totals to keep the digest scannable even with more fields.
  // Line 1 = reach + conversion counts. Line 2 = efficiency metrics.
  const totalsLine1 =
    `*Spend:* ${usd(summary.spend)}  |  ` +
    `*Impr:* ${compact(summary.impressions)}  |  ` +
    `*CPM:* ${usd(summary.cpm)}  |  ` +
    `*CTR:* ${pct(summary.ctr)}  |  ` +
    `*Purchases:* ${num(summary.purchases)}  |  ` +
    `*Trials:* ${num(summary.trialStarts)}`;
  const totalsLine2 =
    `*ROAS:* ${ratio(summary.roas)}  |  ` +
    `*CPA:* ${usdOrDash(summary.cpa)}  |  ` +
    `*Cost/Trial:* ${usdOrDash(summary.cpTrial)}`;

  const platformHeader: SlackBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*── ${label} (${attributionWindow}) ──*\n${totalsLine1}\n${totalsLine2}`,
    },
  };

  return [
    { type: "divider" },
    platformHeader,
    ...rankedSubsection("Top by Spend", topBySpend, section.spendFloor),
    ...rankedSubsection("Top by ROAS", topByRoas, section.roasFloor),
  ];
}

function rankedSubsection(
  title: string,
  items: RankedCreative[],
  floor: number,
): SlackBlock[] {
  // Include the floor in the header so readers can explain "why only 2?"
  // without asking. Format: "Top by Spend ($250+):"
  const header: SlackBlock = {
    type: "section",
    text: { type: "mrkdwn", text: `*${title} (${usd(floor)}+):*` },
  };
  const body: SlackBlock[] = items.length
    ? items.map((c, i) => creativeBlock(c, i + 1))
    : [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `  _No creatives cleared the ${usd(floor)} spend floor._`,
          },
        },
      ];
  return [header, ...body];
}

/**
 * Cross-network roll-up, rendered above the per-platform sections.
 *
 * Two honesty rails, both deliberate:
 *  - When a platform's pull failed, the blended totals silently omit its spend.
 *    That's how a blended ROAS ends up looking great because the worst network
 *    dropped out. So we name the missing platforms inline.
 *  - The platforms report on different attribution windows, so summed revenue
 *    isn't an accounting figure. We say so whenever more than one window is in
 *    the blend.
 */
function rollupBlocks(sections: PlatformSection[], observed?: ObservedAttribution): SlackBlock[] {
  const r = rollup(sections);
  // Nothing pulled — the per-platform error sections already tell that story.
  if (r.networks.length === 0) return [];

  const { blended } = r;
  const totalsLine1 =
    `*Spend:* ${usd(blended.spend)}  |  ` +
    `*Impr:* ${compact(blended.impressions)}  |  ` +
    `*CPM:* ${usd(blended.cpm)}  |  ` +
    `*CTR:* ${pct(blended.ctr)}  |  ` +
    `*Purchases:* ${num(blended.purchases)}  |  ` +
    `*Trials:* ${num(blended.trialStarts)}`;
  const totalsLine2 =
    `*ROAS:* ${ratio(blended.roas)}  |  ` +
    `*CPA:* ${usdOrDash(blended.cpa)}  |  ` +
    `*Cost/Trial:* ${usdOrDash(blended.cpTrial)}`;

  const caveats: string[] = [];
  if (r.excluded.length > 0) {
    const names = r.excluded.map((e) => PLATFORM_LABEL[e.platform]).join(", ");
    caveats.push(
      `:warning: _Excludes ${names} (pull failed) — these totals are partial._`,
    );
  }
  if (r.attributionWindows.length > 1) {
    caveats.push(
      `_Blends ${r.attributionWindows.length} attribution windows (${r.attributionWindows.join("; ")}). ` +
        `Directional, not an accounting figure._`,
    );
  }
  // The blended ROAS is the number most likely to be quoted in a meeting, and
  // it is the least trustworthy one here: each network self-attributes its own
  // revenue, nothing dedupes a customer claimed by two of them, and none of it
  // is reconciled against booked cash. Say so where the number is read.
  caveats.push(
    `_Revenue is platform-claimed, self-attributed, and not deduped across networks._`,
  );

  const header: SlackBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: [`*── All Networks (blended) ──*`, totalsLine1, totalsLine2, ...caveats].join("\n"),
    },
  };

  // Monospace so the columns actually line up in Slack.
  const nameWidth = Math.max(...r.networks.map((n) => PLATFORM_LABEL[n.platform].length));
  const table = r.networks
    .map((n) => {
      const label = PLATFORM_LABEL[n.platform].padEnd(nameWidth);
      const spend = usd(n.summary.spend).padStart(9);
      const share = `${(n.spendShare * 100).toFixed(0)}%`.padStart(4);
      const roas = ratio(n.summary.roas).padStart(5);
      const cpa = usdOrDash(n.summary.cpa).padStart(7);
      return `${label}  ${spend}  ${share}   ROAS ${roas}   CPA ${cpa}`;
    })
    .join("\n");

  const comparison: SlackBlock = {
    type: "section",
    text: { type: "mrkdwn", text: `*Network comparison:*\n\`\`\`\n${table}\n\`\`\`` },
  };

  const blocks = [header, comparison];
  const observedBlock = observedBlocks(r.networks.map((n) => n.platform), observed, sections);
  if (observedBlock) blocks.push(observedBlock);
  return blocks;
}

/**
 * Claimed vs observed, side by side.
 *
 * "Claimed" is each network grading its own homework. "Observed" is RevenueCat
 * revenue joined to an ad click in PostHog. Neither is the truth: claimed is a
 * ceiling (self-attributed, cross-device modelled, not deduped between
 * networks), observed is a floor (only ~40% of booked revenue joins to any
 * click at all). The honest reading is that reality sits between them — so we
 * print the coverage rate right next to the numbers rather than letting the
 * table imply more precision than exists.
 */
function observedBlocks(
  platforms: Platform[],
  observed: ObservedAttribution | undefined,
  sections: PlatformSection[],
): SlackBlock | undefined {
  if (!observed || observed.networks.length === 0) return undefined;

  const spendOf = (p: Platform): number => {
    const s = sections.find((x) => x.ok && x.platform === p);
    return s && s.ok ? s.summary.spend : 0;
  };
  const claimedRevenueOf = (p: Platform): number => {
    const s = sections.find((x) => x.ok && x.platform === p);
    return s && s.ok ? s.summary.revenue : 0;
  };

  const width = Math.max(...platforms.map((p) => PLATFORM_LABEL[p].length), 9);
  const rows = platforms.map((p) => {
    const o = observed.networks.find((n) => n.platform === p);
    const spend = spendOf(p);
    const claimed = claimedRevenueOf(p);
    const obsNet = o?.netRevenue ?? 0;
    const claimedRoas = spend > 0 ? claimed / spend : 0;
    const obsRoas = spend > 0 ? obsNet / spend : 0;
    return (
      `${PLATFORM_LABEL[p].padEnd(width)}  ${usd(spend).padStart(9)}  ` +
      `${ratio(claimedRoas).padStart(7)}  ${ratio(obsRoas).padStart(8)}`
    );
  });

  const head = `${"Network".padEnd(width)}  ${"Spend".padStart(9)}  ${"Claimed".padStart(7)}  ${"Observed".padStart(8)}`;
  const cov = observed.coverage;
  const covPct = cov.revenue > 0 ? (cov.joinableRevenue / cov.revenue) * 100 : 0;

  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        `*Claimed vs observed ROAS:*\n\`\`\`\n${head}\n${rows.join("\n")}\n\`\`\`\n` +
        `_Claimed = the network's own figure (a ceiling). Observed = RevenueCat revenue, ` +
        `net of store fees, joined to an ad click within ${observed.lookbackDays}d (a floor: ` +
        `only ${covPct.toFixed(0)}% of booked revenue joins to any click). Observed excludes renewals._`,
    },
  };
}

function formatDateShort(ymd: string): string {
  // "2026-04-19" → "Apr 19"
  const [y, m, d] = ymd.split("-").map((s) => Number(s));
  if (y === undefined || m === undefined || d === undefined) return ymd;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function buildDigestBlocks(range: DateRange, sections: PlatformSection[],
  observed?: ObservedAttribution,
): SlackBlock[] {
  const pretty = `${formatDateShort(range.start)} → ${formatDateShort(range.end)}`;

  const header: SlackBlock = {
    type: "header",
    text: { type: "plain_text", text: `📊 7-Day Media Digest — ${pretty}` },
  };

  return [header, ...rollupBlocks(sections, observed), ...sections.flatMap(sectionBlocks)];
}

export async function postDigest(
  webhookUrl: string,
  range: DateRange,
  sections: PlatformSection[],
  observed?: ObservedAttribution,
): Promise<void> {
  const blocks = buildDigestBlocks(range, sections, observed);
  const webhook = new IncomingWebhook(webhookUrl);
  const fallbackText = `7-Day Media Digest — ${range.start} to ${range.end}`;
  // Cast: we build blocks with the open-ended SlackBlock shape; @slack/webhook
  // types `blocks` as a strict union that doesn't buy us anything here.
  await webhook.send({ text: fallbackText, blocks: blocks as never });
}
