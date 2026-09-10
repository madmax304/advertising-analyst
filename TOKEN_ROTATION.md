# Token Rotation Runbook

Where tokens live, when they die, how to rotate them. Keep this up to date when things change.

## Quick status

| Platform | Token location (`.env` key) | TTL | Auto-refresh? | Next action by |
|---|---|---|---|---|
| Meta | `META_ACCESS_TOKEN` | 60 days | **Attempted** — digest auto-rolls under 7d left, but see caveat below | Seed once, then automatic |
| TikTok | `TIKTOK_ACCESS_TOKEN` | 1 year | No (but possible) | 2027-04-17 |
| Pinterest | `PINTEREST_ACCESS_TOKEN` | 30 days | **Yes** — auto-refresh on 401 | 2027-04-18 (refresh_token expires) |
| Slack webhook | `SLACK_WEBHOOK_URL` | Never expires | N/A | Only if revoked |

`.env` lives on the Mac Studio at `/Users/maxwellanderson/Documents/Claude/Projects/Advertising Analyst/.env`. It's gitignored — do not commit.

---

## Meta (ACCESS_TOKEN, ~60 days, auto-roll attempted)

### Tooling (added 2026-09-10)

```bash
npm run meta:token            # status — valid? how many days left? which scopes?
pbpaste | npm run meta:token seed   # short-lived → 60-day, writes .env (nothing echoed)
npm run meta:token refresh    # force a long-lived → long-lived roll now
```

`src/adapters/metaAuth.ts` runs at the top of every Meta pull. It inspects the
token via `/debug_token` and, when under **7 days** remain, tries a
`fb_exchange_token` roll and persists the result to `.env`.

**Caveat — this may be a no-op for user tokens.** Meta documents
`fb_exchange_token` as the *short-lived → long-lived* swap. Re-exchanging an
already-long-lived **user** token is not guaranteed to move the expiry; Meta has
historically handed back a token carrying the original expiry. So the auto-roll
measures the before/after expiry and logs
`WARNING: auto-roll did not extend expiry` when it bought nothing — watch for
that line rather than assuming you're covered. `npm run meta:token refresh`
exits non-zero (code 2) in that case, which is the cheap way to find out.

**If the auto-roll turns out to be a no-op, the durable fix is a System User
token** (never expires) — see "Future fix" below. Per `project-plan.md` §5 this
account originally used one, so it may just be a matter of regenerating it.

**An expired token cannot be auto-rolled.** `fb_exchange_token` extends a *live*
token; it can't resurrect a dead one. Once expired, you must reseed by hand.

### Symptoms of expiry
- Digest's Meta section shows `:warning: Pull failed: Meta access token is invalid/expired`
- Or silently shows `Spend: $0` across the board when Meta ads are known to be running
- `npm run meta:token` reports `valid: NO`

### Rotation steps

> Fast path: do steps 1–5 in the browser, copy the token, then run
> `pbpaste | npm run meta:token seed` — it validates the scope, does the
> exchange, and writes `.env` without the token touching your screen, your
> shell history, or a chat transcript. Steps 6–8 below are the manual equivalent.

1. Go to [Graph API Explorer](https://developers.facebook.com/tools/explorer/).
2. Select the Meta app that owns the token: **"KPI Pulse"** — **App ID `527408709796464`** (Mode: In development · Business: Natal). It's shared from a separate project, so look for the name *KPI Pulse* in the Graph Explorer app dropdown — it's separate from the Pinterest and TikTok apps. Its App Secret lives in `.env` as `META_APP_SECRET`.
3. **Token type: User.** In the right-hand panel there's a "User or Page" dropdown — select **User Token** (the default). Do NOT pick a Page token; the Marketing API insights pull is account-level and a Page token won't reach `/act_.../insights`.
4. **Permissions** → add **`ads_read`** (this is the one that matters — it authorizes the account insights pull) and `read_insights` (harmless to include; Graph Explorer may drop it since it's a Page-insights scope — that's fine, `ads_read` is sufficient). Click Generate Access Token.
5. Complete the Facebook auth dialog. Copy the generated token (short-lived, ~1h TTL).
   - Sanity check the token before exchanging: it should come back with scope `ads_read`. Verify with
     `curl -s "https://graph.facebook.com/v20.0/me?access_token=SHORT_LIVED_TOKEN"` → expect your name + ID.
6. Exchange for a 60-day long-lived token in terminal (reads app ID + secret from `.env`, so nothing to paste but the short-lived token):
   ```bash
   source .env && curl -G "https://graph.facebook.com/v20.0/oauth/access_token" \
     --data-urlencode "grant_type=fb_exchange_token" \
     --data-urlencode "client_id=$META_APP_ID" \
     --data-urlencode "client_secret=$META_APP_SECRET" \
     --data-urlencode "fb_exchange_token=SHORT_LIVED_TOKEN"
   ```
7. Copy `access_token` from response into `.env` as `META_ACCESS_TOKEN=`.
8. Verify: `source .env && curl "https://graph.facebook.com/v20.0/me?access_token=$META_ACCESS_TOKEN"` — expect JSON with your name + ID.
9. Run `DIGEST_DRY_RUN=1 npm run digest` to confirm Meta section pulls real data.

### Future fix: System User token (never expires)

If Business Manager access is ever unblocked: generate a System User token instead of a user token. Never expires. See Meta's docs for "System User Token" setup.

### ~~Future fix: auto-roll via `fb_exchange_token`~~ — built 2026-09-10

Implemented in `src/adapters/metaAuth.ts`, wired into the Meta adapter. See
"Tooling" above, including the caveat that this may not actually extend a user
token — in which case the System User route above is the real answer.

---

## TikTok (ACCESS_TOKEN, 1 year, manual)

Not urgent — 1-year TTL. When you rotate, also capture the `refresh_token` this time so future rotations can be automated.

### Symptoms of expiry
- TikTok section shows `:warning: Pull failed: TikTok report code=40001`

### Rotation steps

1. Build authorize URL (replace APP_ID):
   ```
   https://business-api.tiktok.com/portal/auth?app_id=APP_ID&state=natal&redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fcallback
   ```
   App ID: `7491873522415992849`.
2. Sign in, approve Natal's advertiser account, click Confirm.
3. Browser redirects to `http://localhost:8000/callback?auth_code=...` (fails to load — check URL bar).
4. Copy `auth_code` from URL.
5. Exchange for access token:
   ```bash
   curl -X POST "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/" \
     -H "Content-Type: application/json" \
     -d '{"app_id":"APP_ID","secret":"APP_SECRET","auth_code":"AUTH_CODE"}'
   ```
6. Response includes `data.access_token`, `data.advertiser_ids`, and `data.refresh_token`.
7. Update `.env`:
   - `TIKTOK_ACCESS_TOKEN` → new access_token
   - Keep `TIKTOK_ADVERTISER_ID=7407895255842062337` (Natal)
   - Optionally capture `TIKTOK_REFRESH_TOKEN` for future automation

### Future fix: refresh automation

TikTok's OAuth response includes a `refresh_token`. Add a TikTok auth module mirroring `src/adapters/pinterestAuth.ts` — refresh on 401, update `.env`, retry. Estimated effort: ~30 min once refresh_token is captured.

---

## Pinterest (ACCESS_TOKEN, 30 days, AUTO-REFRESHED)

Mostly hands-off. The digest auto-refreshes the access token on 401 using the `PINTEREST_REFRESH_TOKEN` in `.env`. See [`src/adapters/pinterestAuth.ts`](src/adapters/pinterestAuth.ts).

### Symptoms requiring manual action
Only if the refresh_token itself dies (1-year TTL, or if Pinterest revokes early). Signs:
- Digest's Pinterest section shows `:warning: Pinterest token refresh failed`
- `.env` shows an access_token that's noticeably old but can't be refreshed

### Full re-auth steps (only if refresh_token is dead)

1. Go to [Pinterest app page](https://developers.pinterest.com/apps/1562586).
2. Build authorize URL:
   ```
   https://www.pinterest.com/oauth/?response_type=code&client_id=1562586&redirect_uri=https%3A%2F%2Flocalhost%2F&scope=ads%3Aread&state=natal
   ```
3. Authorize → redirect to `https://localhost/?code=...` (fails to load, check URL bar).
4. Exchange:
   ```bash
   curl -s -X POST "https://api.pinterest.com/v5/oauth/token" \
     -u "1562586:APP_SECRET" \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -d "grant_type=authorization_code" \
     -d "code=AUTH_CODE" \
     -d "redirect_uri=https://localhost/"
   ```
5. Response includes `access_token` (paste into `PINTEREST_ACCESS_TOKEN`) and `refresh_token` (paste into `PINTEREST_REFRESH_TOKEN`).

App secret rotates occasionally; if you rotate it, update `PINTEREST_APP_SECRET` in `.env` AND re-do the full OAuth flow above (existing refresh_token tied to old secret).

---

## Slack webhook

Doesn't expire. Only rotate if:
- The URL leaked somewhere public (rotate at Slack App settings → Incoming Webhooks → revoke + regenerate)
- You want to point at a different channel (regenerate, pick the new channel)

Update `SLACK_WEBHOOK_URL` in `.env` after rotation.

---

## Testing without posting to Slack (dry run)

Default to this whenever you touch tokens or code — no more testing live in the channel.

```bash
npm run digest:dry              # = DIGEST_DRY_RUN=1 npm run digest
npm run --silent digest:dry     # add --silent when piping/copying the JSON (drops npm's 2-line banner)
```

This runs the full pipeline (real API pulls for every platform) but prints the Slack Block Kit JSON to stdout **instead of posting**. What to check:

- **No `[digest] <platform> failed:` lines** on stderr — every platform section pulled cleanly.
- **Scan the JSON** for each platform's summary line (e.g. `── Meta (7-day click) ──`) and confirm spend/ROAS look non-zero and sane.
- **Preview the actual rendering** (optional): copy the JSON `blocks` array into Slack's [Block Kit Builder](https://app.slack.com/block-kit-builder) to see exactly how it'll look — thumbnails, links, layout — before any real post.

Only once the dry run looks right, run `npm run digest` to post for real.

---

## General tips

- **Always dry-run after rotating.** Run `npm run digest:dry` (see above) and check the relevant platform's section before closing the laptop. Only post live once it looks right.
- **Don't commit `.env`.** The `.gitignore` covers it, but double-check after any `git status` shows untracked files.
- **Rotate any secret pasted into a chat transcript** after you're done. Chat transcripts may persist in ways you don't expect.
- **The scheduled task runs at 8am Pacific daily** on the Mac Studio. Mac must be awake. Task lives at `~/.claude/scheduled-tasks/media-digest/SKILL.md`.
