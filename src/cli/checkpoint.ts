import "dotenv/config";
import {
  buildWeek,
  fetchFunnel,
  lastCompleteWeeks,
  type CheckpointWeek,
  type FunnelWeek,
  type WeekRange,
} from "../analyst/checkpoint.js";
import { checkAll } from "./tokens.js";
import type { Platform } from "../types.js";

/**
 * Weekly media checkpoint.
 *
 *   npm run checkpoint              last 4 complete weeks
 *   npm run checkpoint -- --weeks 8
 *   npm run checkpoint -- --json    machine-readable, for writing a report from
 *
 * Prints the numbers only. Interpreting them is the job of the /media-checkpoint
 * command, which carries the reading rules — chiefly that the most recent week
 * is still maturing and must be compared against what the previous week read at
 * the same age.
 */

const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number, dp = 2): string => `${(n * 100).toFixed(dp)}%`;
const ratio = (n: number): string => n.toFixed(2);
const div = (a: number, b: number): number => (b > 0 ? a / b : 0);
const pad = (s: string, n: number): string => (s.length >= n ? s : " ".repeat(n - s.length) + s);
const padR = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

const PLATFORMS: Platform[] = ["meta", "tiktok", "pinterest"];
const LABEL: Record<Platform, string> = { meta: "Meta", tiktok: "TikTok", pinterest: "Pinterest" };

function totals(w: CheckpointWeek) {
  let spend = 0;
  let claimed = 0;
  let observed = 0;
  for (const p of PLATFORMS) {
    const n = w.networks[p];
    if (!n) continue;
    spend += n.spend;
    claimed += n.claimedRevenue;
    observed += n.observedNet;
  }
  return { spend, claimed, observed };
}

function printSummary(weeks: CheckpointWeek[], funnel: FunnelWeek[]): void {
  console.log("\nALL NETWORKS");
  console.log(
    "  week        spend   claimed  observed   new cust  coverage  maturity",
  );
  weeks.forEach((w, i) => {
    const t = totals(w);
    const f = funnel[i];
    const mat = w.week.daysMatured < 7 ? `${w.week.daysMatured}d *` : `${w.week.daysMatured}d`;
    console.log(
      "  " +
        padR(w.week.label, 12) +
        pad(usd(t.spend), 8) +
        pad(ratio(div(t.claimed, t.spend)), 10) +
        pad(ratio(div(t.observed, t.spend)), 10) +
        pad(f ? String(f.newCustomers) : "—", 11) +
        pad(w.coverage === undefined ? "—" : pct(w.coverage, 0), 10) +
        pad(mat, 10),
    );
  });
  const freshest = weeks[weeks.length - 1]?.week.daysMatured ?? 99;
  if (freshest <= 3) {
    console.log(
      "\n  * PROVISIONAL. The newest week has had " +
        `${freshest} day(s) to mature, against the ~7 a cohort needs. Its conversion\n` +
        "    and paywall figures WILL rise. Do not report them as a decline. Compare\n" +
        "    them only against what the previous week read at the same age.",
    );
  } else if (weeks.some((w) => w.week.daysMatured < 7)) {
    console.log(
      "  * fewer than 7 days to mature — this week will read better once it settles.",
    );
  }
}

function printNetworks(weeks: CheckpointWeek[]): void {
  for (const p of PLATFORMS) {
    if (!weeks.some((w) => w.networks[p])) continue;
    console.log(`\n${LABEL[p].toUpperCase()}`);
    console.log("  week        spend      CPM     CTR   claimed   observed");
    for (const w of weeks) {
      const n = w.networks[p];
      if (!n) {
        console.log("  " + padR(w.week.label, 12) + pad("(pull failed)", 10));
        continue;
      }
      console.log(
        "  " +
          padR(w.week.label, 12) +
          pad(usd(n.spend), 8) +
          pad("$" + (div(n.spend, n.impressions) * 1000).toFixed(2), 9) +
          pad(pct(div(n.clicks, n.impressions)), 8) +
          pad(ratio(div(n.claimedRevenue, n.spend)), 10) +
          pad(ratio(div(n.observedNet, n.spend)), 11),
      );
    }
  }
}

function printSourceSplit(weeks: CheckpointWeek[]): void {
  if (!weeks.some((w) => w.metaBySource.vendor.spend > 0)) return;
  console.log("\nMETA BY CREATIVE SOURCE  (campaign-name split; see canon)");
  console.log("  week          vendor spend  claimed    in-house spend  claimed");
  for (const w of weeks) {
    const v = w.metaBySource.vendor;
    const h = w.metaBySource.inHouse;
    console.log(
      "  " +
        padR(w.week.label, 12) +
        pad(usd(v.spend), 13) +
        pad(ratio(div(v.claimedRevenue, v.spend)), 9) +
        pad(usd(h.spend), 18) +
        pad(ratio(div(h.claimedRevenue, h.spend)), 9),
    );
  }
}

function printFunnel(funnel: FunnelWeek[]): void {
  console.log("\nWEB FUNNEL  join.natal.app, paid visitors, cohorted by first visit");
  console.log("  week        visitors  signup   plan    paid    paywall  free-tr  login");
  for (const f of funnel) {
    const rate = (n: number) => pct(div(n, f.paidVisitors));
    console.log(
      "  " +
        padR(f.week, 12) +
        pad(String(f.paidVisitors), 8) +
        pad(rate(f.paidSignupDone), 9) +
        pad(rate(f.paidPlanSelect), 8) +
        pad(rate(f.paidConverted), 8) +
        pad(f.nonTrialToPaid.toFixed(1) + "%", 9) +
        pad(f.freeTrialShare.toFixed(1) + "%", 9) +
        pad(f.completeLoginPct.toFixed(1) + "%", 8),
    );
  }
  console.log(
    "  paywall = conversion once an offer is picked, excluding free trials.\n" +
      "  login   = share whose next act after sign_up_complete is complete_login (May baseline 3.2%).",
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const wIdx = argv.indexOf("--weeks");
  const count = wIdx >= 0 ? Math.max(1, Math.min(26, Number(argv[wIdx + 1]) || 4)) : 4;

  const weekRanges: WeekRange[] = lastCompleteWeeks(count);
  if (!json) {
    const first = weekRanges[0];
    const last = weekRanges[weekRanges.length - 1];
    console.error(
      `[checkpoint] ${count} weeks, ${first?.start} to ${last?.end} — pulling…`,
    );
  }

  // Weeks in sequence: each one refreshes the Meta token at the top of its pull.
  const weeks: CheckpointWeek[] = [];
  for (const range of weekRanges) weeks.push(await buildWeek(range));

  let funnel: FunnelWeek[] = [];
  try {
    funnel = await fetchFunnel(weekRanges);
  } catch (err) {
    console.error(
      "[checkpoint] funnel unavailable:",
      err instanceof Error ? err.message : err,
    );
  }

  const tokens = await checkAll();

  if (json) {
    console.log(JSON.stringify({ weeks, funnel, tokens }, null, 2));
    return;
  }

  const last = weekRanges[weekRanges.length - 1];
  console.log(`\n=== WEEKLY CHECKPOINT — week of ${last?.start} to ${last?.end} ===`);

  printSummary(weeks, funnel);
  printNetworks(weeks);
  printSourceSplit(weeks);
  if (funnel.length > 0) printFunnel(funnel);

  console.log("\nTOKENS");
  for (const t of tokens) {
    console.log(
      "  " + padR(t.platform, 11) + padR(t.ok ? "OK" : t.needsManualAuth ? "RE-AUTH" : "FAIL", 9) + t.detail,
    );
  }

  const problems = weeks.flatMap((w) => w.errors.map((e) => `${w.week.label}  ${e}`));
  if (problems.length > 0) {
    console.log("\nPULL ERRORS");
    for (const p of problems) console.log("  " + p);
  }

  // A checkpoint whose data half silently failed is worse than no checkpoint —
  // it looks complete. Exit non-zero so a scheduled run surfaces it.
  const missingObserved = weeks.every((w) => totals(w).observed === 0);
  if (problems.length > 0 || missingObserved) {
    if (missingObserved) console.log("\n  WARNING: no observed revenue in any week.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[checkpoint] fatal:", err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
