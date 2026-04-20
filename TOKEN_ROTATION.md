# Token Rotation Runbook

Where tokens live, when they die, how to rotate them. Keep this up to date when things change.

## Quick status

| Platform | Token location (`.env` key) | TTL | Auto-refresh? | Next action by |
|---|---|---|---|---|
| Meta | `META_ACCESS_TOKEN` | 60 days | No | **2026-06-15** |
| TikTok | `TIKTOK_ACCESS_TOKEN` | 1 year | No (but possible) | 2027-04-17 |
| Pinterest | `PINTEREST_ACCESS_TOKEN` | 30 days | **Yes** — auto-refresh on 401 | 2027-04-18 (refresh_token expires) |
| Slack webhook | `SLACK_WEBHOOK_URL` | Never expires | N/A | Only if revoked |

`.env` lives on the Mac Studio at `/Users/maxwellanderson/Documents/Claude/Projects/Advertising Analyst/.env`. It's gitignored — do not commit.

---

## Meta (ACCESS_TOKEN, ~60 days, manual)

Most urgent. 60-day lifespan means you rotate every ~55 days to stay ahead.

### Symptoms of expiry
- Digest's Meta section shows `:warning: Pull failed: OAuthException` or `code 190`
- Or silently shows `Spend: $0` across the board when Meta ads are known to be running

### Rotation steps

1. Go to [Graph API Explorer](https://developers.facebook.com/tools/explorer/).
2. Select the Meta app that owns the token. App ID is whichever you configured when setting up (check transcript or Business Manager — it's separate from the Pinterest app).
3. **User or Page** → User Access Token.
4. **Permissions** → add `ads_read` and `read_insights`. Click Generate Access Token.
5. Complete the Facebook auth dialog. Copy the generated token (short-lived, ~1h TTL).
6. Exchange for a 60-day long-lived token in terminal:
   ```bash
   curl -G "https://graph.facebook.com/v20.0/oauth/access_token" \
     --data-urlencode "grant_type=fb_exchange_token" \
     --data-urlencode "client_id=YOUR_APP_ID" \
     --data-urlencode "client_secret=YOUR_APP_SECRET" \
     --data-urlencode "fb_exchange_token=SHORT_LIVED_TOKEN"
   ```
7. Copy `access_token` from response into `.env` as `META_ACCESS_TOKEN=`.
8. Verify: `source .env && curl "https://graph.facebook.com/v20.0/me?access_token=$META_ACCESS_TOKEN"` — expect JSON with your name + ID.
9. Run `DIGEST_DRY_RUN=1 npm run digest` to confirm Meta section pulls real data.

### Future fix: System User token (never expires)

If Business Manager access is ever unblocked: generate a System User token instead of a user token. Never expires. See Meta's docs for "System User Token" setup.

### Future fix: auto-roll via `fb_exchange_token`

Could add a Meta-side refresh module similar to `src/adapters/pinterestAuth.ts`. Call `fb_exchange_token` proactively at the start of each digest if the token is <7 days from expiry. Estimated effort: ~1 hour.

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

## General tips

- **Always test after rotating.** Run `DIGEST_DRY_RUN=1 npm run digest` and check the relevant platform's section before closing the laptop.
- **Don't commit `.env`.** The `.gitignore` covers it, but double-check after any `git status` shows untracked files.
- **Rotate any secret pasted into a chat transcript** after you're done. Chat transcripts may persist in ways you don't expect.
- **The scheduled task runs at 8am Pacific daily** on the Mac Studio. Mac must be awake. Task lives at `~/.claude/scheduled-tasks/media-digest/SKILL.md`.
