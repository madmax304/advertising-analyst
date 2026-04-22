import { IncomingWebhook } from "@slack/webhook";
import type { Platform, DateRange } from "../types.js";
import type { Summary } from "../analyst/summarize.js";
import type { RankedCreative } from "../analyst/rankCreatives.js";

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
  const body = `*${rank}.* ${nameText}\nROAS *${ratio(c.roas)}*, Spend ${usd(c.spend)}, ${plural(c.trialStarts, "trial")}`;

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

export function buildDigestBlocks(range: DateRange, sections: PlatformSection[]): SlackBlock[] {
  const pretty = `${formatDateShort(range.start)} → ${formatDateShort(range.end)}`;

  const header: SlackBlock = {
    type: "header",
    text: { type: "plain_text", text: `📊 7-Day Media Digest — ${pretty}` },
  };

  return [header, ...sections.flatMap(sectionBlocks)];
}

export async function postDigest(
  webhookUrl: string,
  range: DateRange,
  sections: PlatformSection[],
): Promise<void> {
  const blocks = buildDigestBlocks(range, sections);
  const webhook = new IncomingWebhook(webhookUrl);
  const fallbackText = `7-Day Media Digest — ${range.start} to ${range.end}`;
  // Cast: we build blocks with the open-ended SlackBlock shape; @slack/webhook
  // types `blocks` as a strict union that doesn't buy us anything here.
  await webhook.send({ text: fallbackText, blocks: blocks as never });
}
