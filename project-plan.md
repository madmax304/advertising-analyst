# Media Buying Analyst — Cowork + Slack Digest Project Plan

**Date:** 2026-04-16
**Owner:** Maxwell
**Status:** Draft v3 (decisions locked, ready to scaffold)

## 1. Goal & Success Criteria

A local Node CLI that pulls ad performance data directly from Meta, TikTok, and Pinterest and posts a daily digest to a single Slack channel via an incoming webhook. Claude in Cowork handles all ad-hoc Q&A by invoking the same adapter scripts directly — no separate bot, no hosted service, no LLM integration.

**Motivation:** Your team already has a mature internal data pipeline that ingests this data, but you want a consolidated, high-level daily view in Slack so the team doesn't have to log into three separate ads managers to eyeball performance.

**Scope decisions (locked in this draft):**
- **Siloed per-platform reporting.** Digest has three sections, one per platform. No cross-platform roll-ups. Each section is labeled with that platform's native attribution window.
- **Simple metrics only in v1.** Top-performing creatives by ROAS per platform, plus headline totals (spend, purchases, trial starts, ROAS, CPA).
- **Trial starts are a first-class metric** alongside purchases — the business operates on a start-trial model.
- **Q&A lives in Cowork, not Slack.** Slack is one-way.
- **No storage, no database, no warehouse.** Period-over-period comparisons are explicitly deferred.
- **Runs locally.** Cowork's scheduled-tasks skill fires the digest daily; nothing hosted.
- **One ad account per platform.**
- **All revenue in USD (assumed — to confirm).**

**Definition of done for v1:**
- Digest pulls yesterday's creative-level data from all three platforms and posts a formatted Slack message.
- Cowork scheduled task fires it at 8am local time daily.
- Manual fire path works (`npm run digest`) for testing.
- `query` CLI exists so Claude-in-Cowork can answer ad-hoc questions against the same adapters.

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                   Your Mac (local)                           │
│                                                              │
│  ┌────────────────────┐                                      │
│  │  Cowork / Claude   │  ◄── you ask Q&A here                │
│  └─────────┬──────────┘                                      │
│            │ runs via Bash tool                              │
│            ▼                                                 │
│  ┌────────────────────────────────────────────────┐          │
│  │  Node CLI (TypeScript)                         │          │
│  │                                                │          │
│  │   src/cli/digest.ts   ── daily Slack post      │          │
│  │   src/cli/query.ts    ── ad-hoc JSON for Claude│          │
│  │        │                                       │          │
│  │        ▼                                       │          │
│  │   src/analyst/   (pure fns, ranking, metrics)  │          │
│  │        │                                       │          │
│  │        ▼                                       │          │
│  │   src/adapters/  meta.ts | tiktok.ts | pin.ts  │          │
│  └────────┬───────────────────────────────────────┘          │
│           │                                                  │
└───────────┼──────────────────────────────────────────────────┘
            │
            ├─────────► Meta Marketing API       (creds exist)
            ├─────────► TikTok Business API      (creds exist)
            ├─────────► Pinterest Ads API        (NEW)
            │
            └─────────► Slack incoming webhook ──► one channel
```

**Digest shape in Slack:**
```
📊 Daily Media Digest — Tue Apr 16

── Meta (7-day click attribution) ──
Spend: $X  |  Purchases: X  |  Trials: X  |  ROAS: X.XX  |  CPA: $X
Top creatives by ROAS:
  1. <creative name> — ROAS X.XX, Spend $X
  2. ...

── TikTok (7-day click / 1-day view attribution) ──
[same shape]

── Pinterest (30-day click attribution) ──
[same shape]
```

## 3. Tech Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Runtime | **Node 20+** | Current LTS |
| Language | **TypeScript** | Keeps the three adapters honest on the shared schema |
| HTTP | native fetch (Node 18+) | No axios needed |
| Meta SDK | **facebook-nodejs-business-sdk** | Official, saves pain on Meta's graph |
| TikTok | direct REST via fetch | No official Node SDK |
| Pinterest | direct REST via fetch | No official Node SDK |
| Slack | **@slack/webhook** | Thin wrapper over the incoming-webhook POST |
| Config | **dotenv** | `.env` for API tokens + webhook URL |
| Scheduling | Cowork scheduled-tasks skill | No cron infra |
| Build | **tsx** for dev + `tsc` for build | |
| Storage | **none** | Explicitly deferred |

## 4. Component Breakdown

### 4.1 Normalized schema
```ts
type CreativeMetrics = {
  date: string;                 // YYYY-MM-DD
  platform: "meta" | "tiktok" | "pinterest";
  attributionWindow: string;    // e.g. "7-day click", labeled in output
  campaignId: string;
  campaignName: string;
  adId: string;
  adName: string;
  creativeId: string;
  spend: number;                // USD
  impressions: number;
  clicks: number;
  purchases: number;
  revenue: number;              // from purchase events
  trialStarts: number;          // first-class metric (start-trial business model)
};
```

### 4.2 Platform adapters (`src/adapters/*.ts`)
Each exports:
```ts
async function fetchCreativeMetrics(
  dateRange: { start: string; end: string }
): Promise<CreativeMetrics[]>;
```
Per-adapter responsibilities: auth, pagination, mapping the platform's purchase event into `purchases`, and stamping its native attribution window into every row.

**Trial starts are deferred in v1.** Adapters return `trialStarts: 0` and log the raw conversion-action array from each API response on the first few runs. Once we can eyeball which conversion action corresponds to a trial start in each platform (much faster than reverse-engineering from the docs), we flip on real counting in a small follow-up.

### 4.3 Analyst core (`src/analyst/*.ts`)
Pure functions, no I/O:
- `summarize(metrics)` — totals for a single platform: spend, purchases, trialStarts, revenue, ROAS (revenue/spend), CPA (spend/purchases), CPTrial (spend/trialStarts)
- `rankCreatives(metrics, { by: "roas", n: 3, minSpend: 50 })` — top N with a spend floor so a $2 creative doesn't win

Deferred to v2: `periodOverPeriod`, `flagMovers`, cross-platform comparison.

### 4.4 Slack output (`src/slack/digest.ts`)
- Block Kit message with a header and three sibling sections, one per platform.
- Each section header labels the native attribution window in plain text.
- Per-platform body: one line of totals, then top 3 creatives by ROAS.
- Posts via `@slack/webhook`.

### 4.5 CLI entry points
- **`digest.ts`** — pulls yesterday across all three platforms, renders Block Kit, posts. What the scheduler fires. Runnable manually via `npm run digest`.
- **`query.ts`** — parses `--platform`, `--days`, `--metric` flags, prints JSON. What Claude-in-Cowork calls via Bash to answer your ad-hoc questions.

### 4.6 Cowork scheduled task
One scheduled task at `0 8 * * *` with a prompt like:

> Run the media buying daily digest by executing `cd ~/Advertising\ Analyst && npm run digest`. If it exits non-zero or prints errors, summarize the failure; otherwise report "posted" with the Slack message timestamp.

Buys us: 8am daily delivery, Claude-in-the-loop error reporting, manual "fire now" button via the Cowork task UI for testing.

## 5. API Access Status

| Platform | Status | What's needed |
|----------|--------|---------------|
| Meta Marketing API | ✅ **Approved** | Port existing System User token + `ad_account_id` into `.env` |
| TikTok Business API | ✅ **Approved** | Port existing access token + `advertiser_id` into `.env` |
| Pinterest Ads API | ⬜ **Net-new** | Create app at developers.pinterest.com, request `ads:read`, complete OAuth, capture access token + `ad_account_id` |
| Slack incoming webhook | ⬜ **Net-new** | `Apps → Incoming Webhooks → Add to Slack`, pick channel, copy URL |

The Meta App Review risk from v1/v2 of this plan is gone — you already have it.

## 6. Phased Roadmap

**Reordered to front-load the unknown.** Pinterest is the only platform we haven't built against before, so shipping it first de-risks the project faster than starting with a port-job on a platform we already know works.

### Week 1 — Pinterest end-to-end
- Project scaffold (TS, npm scripts, `.env`) under `/Advertising Analyst/`
- Pinterest adapter returning normalized `CreativeMetrics[]`
- Analyst core (`summarize`, `rankCreatives`)
- Slack webhook wiring + Block Kit digest composer
- `digest.ts` posts a Pinterest-only digest; `query.ts` handles one canned question
- **Ship criterion:** `npm run digest` posts a real Pinterest digest to your channel.

### Week 2 — Port Meta & TikTok from legacy code
- Read your existing adapters, port field mappings and pagination into the new TS structure
- Extend digest with Meta and TikTok sections
- **Ship criterion:** all three platforms reporting side-by-side in one digest.

### Week 3 — Schedule + stabilize
- Create the Cowork scheduled task for 8am daily
- Let it run a few days; fix brittle spots (rate limits, empty-day edges, null revenue fallbacks)
- **Ship criterion:** digest has fired reliably for 3 consecutive days without intervention.

### Deferred to v2
- Period-over-period comparisons (requires storage)
- Anomaly alerts
- Multi-account support
- Campaign- and audience-level drill-downs
- Chart images in Slack
- Sourcing data from your internal pipeline instead of direct APIs (would eliminate a lot of duplicated field-mapping work once we have more than a daily digest to serve)

## 7. Risks & Assumptions

Most of the v1/v2 risks are closed out. Remaining:
- **Trial-start event mapping varies per platform.** Each platform has its own custom conversion setup; need to confirm the exact event name PostHog uses for each so the adapters count the right thing. (Listed in §8.)
- **Scheduled task fires only when Cowork is running.** Mac stays awake per your note — OK.
- **Currency assumption.** v1 assumes all three accounts in USD; if that's wrong we need per-platform currency formatting.

## 8. Kickoff Checklist (consolidated)

Everything needed to start week 1. I'll execute against each as you hand them over.

**API access / credentials**
1. **Slack incoming webhook URL** — create via `Apps → Incoming Webhooks` pointed at the target channel. Paste the URL; I'll drop it into `.env`.
2. **Target Slack channel name** — just so we're aligned on where the webhook posts.
3. **Pinterest** — create a Pinterest developer app, request `ads:read`, complete OAuth, provide the access token and `ad_account_id`.
4. **Meta credentials** (from your legacy code) — System User access token + `ad_account_id` (format `act_XXXXXXX`).
5. **TikTok credentials** (from your legacy code) — access token + `advertiser_id`.

**Data & event mapping**
6. **Pointer to your legacy Meta/TikTok adapter code** — repo path or a drop of the relevant files. We'll port field mappings, auth, and pagination rather than rebuilding from scratch.
7. **Trial-start event mapping** — *deferred*. Adapters will stub `trialStarts: 0` and log raw conversion actions on first runs so we can eyeball which event to map, then turn on real counting in a small follow-up.
8. **Currency confirmation** — all three accounts in USD? (If any are in a different currency, flag it now.)

**Configuration**
9. **Schedule** — 8am **which time zone**? I'll assume your local but confirm.
10. **Mono-repo path and folder name.** Confirmed mono-repo. Need the local path to the repo on your Mac (so Cowork can mount it) and a folder name inside the repo where this project should live (e.g. `media-analyst/` or `ads/analyst/`).

**Environment**
11. **Node 20+ installed on your Mac** — run `node -v` to check. If it's older, `nvm install 20` will fix it.
