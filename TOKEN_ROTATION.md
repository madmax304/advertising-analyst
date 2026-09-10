# Token Rotation Runbook

Where tokens live, when they die, how to rotate them. Keep this up to date when things change.

## Check status first

```bash
npm run tokens
```

Shows every platform's token: valid or not, days left, scopes, and — when a
human is genuinely needed — the exact commands to fix it. Read-only; it never
rotates anything.

| Platform | Token location (`.env` key) | TTL | Auto-renewed? |
|---|---|---|---|
| Meta | `META_ACCESS_TOKEN` | 60 days | **Yes** — rolled at <14d left via `fb_exchange_token` |
| TikTok | `TIKTOK_ACCESS_TOKEN` | 1 year | No — monitored only (no refresh_token captured) |
| Pinterest | `PINTEREST_ACCESS_TOKEN` | 30 days | **Yes** — renewed at <7d left, plus 401 fallback |
| Slack webhook | `SLACK_WEBHOOK_URL` | Never expires | N/A |

## How renewal works

`npm run digest` runs a **token preflight** before pulling any data: anything
close to expiry is renewed first, so the digest stops discovering dead
credentials by failing on them. Renewal is never fatal — a platform that can't
be renewed still gets its pull attempted and renders as an error section.

```bash
npm run tokens          # status only, no rotation
npm run tokens:renew    # renew anything near expiry, then show status
```

**Two things software cannot fix**, both needing a one-time re-auth:

- **A Meta token left to fully expire.** `fb_exchange_token` extends a *valid*
  long-lived token; it cannot revive a dead one. Renewing at <14d left is what
  keeps this from happening.
- **A lost OAuth scope.** A refresh can never add a scope the grant doesn't
  have. Only re-authorizing rebuilds the grant.

`npm run tokens` prints the fix for each. After seeding once, both stay
hands-off.

### Where `.env` is found

The auth modules resolve `.env` explicitly — `MEDIA_DIGEST_ENV_FILE`, else
`DOTENV_CONFIG_PATH`, else the package root, else cwd — and **verify it's
writable before exchanging anything**. This matters: providers rotate refresh
tokens on exchange, so a write that fails *after* the exchange destroys the only
copy of a live credential. Running from a git worktree (no `.env`) now fails
loudly with nothing spent, instead of quietly stranding a rotated token.

`.env` lives on the Mac Studio at `/Users/maxwellanderson/Documents/Claude/Projects/Advertising Analyst/.env`. It's gitignored — do not commit.

---

## Meta (ACCESS_TOKEN, ~60 days, AUTO-RENEWED)

The digest rolls this automatically once it's under 14 days left, via
`fb_exchange_token` (see [`src/adapters/metaAuth.ts`](src/adapters/metaAuth.ts)).
Two caveats worth knowing:

- **It cannot revive an already-expired token.** If the digest doesn't run for a
  few weeks and the token lapses, the steps below are the only way back.
- **Meta doesn't always extend.** Re-exchange usually returns a fresh 60-day
  expiry, but not guaranteed; the roll logs `expiry <before> -> <after>` so you
  can see what actually happened rather than assume.

The permanent fix is a System User token (never expires) — see below.

### Rotation steps (only when it has fully expired)

Steps 1-5 below get you a short-lived token; then instead of the manual curl
exchange, run:

```bash
npm run tokens:seed:meta -- <short-lived-token>
```

That exchanges it for a 60-day token, writes it to `.env`, records the expiry,
and warns if `ads_read` is missing. From then on the digest keeps it alive.

### Symptoms of expiry
- Digest's Meta section shows `:warning: Pull failed: OAuthException` or `code 190`
- Or silently shows `Spend: $0` across the board when Meta ads are known to be running

### Rotation steps

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

### ~~Future fix: auto-roll via `fb_exchange_token`~~ — done (2026-09-10)

Implemented in [`src/adapters/metaAuth.ts`](src/adapters/metaAuth.ts); the digest
preflight calls it every run.

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

### Scopes

The token needs **`ads:read`, `pins:read`, `boards:read`, `user_accounts:read`**.
Reporting only needs `ads:read`; the digest's creative thumbnails call
`GET /pins/{id}`, which needs `pins:read` + `boards:read`.

Pinterest returns **401 for a missing scope**, same status as a dead token — the
response body is the only difference (`"Missing: ['boards:read', 'pins:read']"`).
The adapter now includes that body in its error and refuses to "refresh" a scope
error, since a refresh cannot add a scope the grant never had.

> **Historical gotcha (fixed 2026-09-10).** `refreshAccessToken()` used to pass
> `scope: "ads:read"` on the refresh call. An OAuth refresh that names a scope
> *narrows* the new token to it, so the first auto-refresh after the April 2026
> re-auth quietly dropped the three non-ads scopes. Metrics kept working;
> thumbnails 401'd. The refresh no longer sends `scope`, which preserves the
> grant's original scopes, and it logs the scopes it got back.

### Symptoms requiring manual action
Only if the refresh_token itself dies (1-year TTL, or if Pinterest revokes early). Signs:
- Digest's Pinterest section shows `:warning: Pinterest token refresh failed`
- `.env` shows an access_token that's noticeably old but can't be refreshed

If thumbnails are missing but metrics are fine, that's a **scope** problem, not
expiry — look for `[pinterest] thumbnails unavailable` on stderr and re-auth
with the full scope list above.

### Full re-auth steps

Needed when the refresh_token dies **or when the grant loses a scope** (see the
gotcha above — that's what happened on 2026-09-10).

```bash
npm run tokens:authurl     # prints the authorize URL with all four scopes
```

1. Open the printed URL, approve **every** scope checkbox.
2. The browser redirects to `https://localhost/?code=...` and fails to load —
   that's expected, copy the `code` value out of the URL bar.
3. Seed it (auth codes are single-use and expire fast, so don't dawdle):

   ```bash
   npm run tokens:seed:pinterest -- <auth_code>
   ```

That stores both tokens, records expiry, and prints the granted scopes so you
can confirm all four landed. Then `npm run tokens` to verify, and the digest
keeps it renewed from there.


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
