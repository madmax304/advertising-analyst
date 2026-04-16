import { IncomingWebhook } from "@slack/webhook";
import type { Platform } from "../types.js";
import type { Summary } from "../analyst/summarize.js";
import type { RankedCreative } from "../analyst/rankCreatives.js";

export type PlatformSection =
  | {
      ok: true;
      platform: Platform;
      attributionWindow: string;
      summary: Summary;
      topCreatives: RankedCreative[];
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

  const { summary, topCreatives, attributionWindow } = section;
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

  const topLines = topCreatives.length
    ? topCreatives
        .map(
          (c, i) =>
            `  ${i + 1}. ${truncateAdName(c.adName)} — ROAS ${ratio(c.roas)}, Spend ${usd(c.spend)}, ${plural(c.trialStarts, "trial")}`,
        )
        .join("\n")
    : "  _No creatives cleared the spend floor._";

  return [
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*── ${label} (${attributionWindow}) ──*\n${totalsLine1}\n${totalsLine2}\n*Top creatives by ROAS:*\n${topLines}`,
      },
    },
  ];
}

export function buildDigestBlocks(date: string, sections: PlatformSection[]): SlackBlock[] {
  // date is YYYY-MM-DD; format like "Thu Apr 16"
  const [y, m, d] = date.split("-").map((s) => Number(s));
  const pretty =
    y !== undefined && m !== undefined && d !== undefined
      ? new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        })
      : date;

  const header: SlackBlock = {
    type: "header",
    text: { type: "plain_text", text: `📊 Daily Media Digest — ${pretty}` },
  };

  return [header, ...sections.flatMap(sectionBlocks)];
}

export async function postDigest(
  webhookUrl: string,
  date: string,
  sections: PlatformSection[],
): Promise<void> {
  const blocks = buildDigestBlocks(date, sections);
  const webhook = new IncomingWebhook(webhookUrl);
  // `text` is a fallback for notifications + clients that don't render blocks.
  // Cast: we build blocks with the open-ended SlackBlock shape; @slack/webhook
  // types `blocks` as a strict union that doesn't buy us anything here.
  await webhook.send({ text: `Daily Media Digest — ${date}`, blocks: blocks as never });
}
