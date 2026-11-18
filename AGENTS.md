# AGENTS.md: setup and maintenance handoff

You are setting up (or maintaining) a **read-only Canvas LMS MCP server** on **Cloudflare Workers**, protected by **GitHub OAuth**, for one person to use as a **claude.ai custom connector** (web + phone). The person is probably **not technical**. Do as much as you can yourself, stop only at the human-gated steps below, and explain those in plain words.

Your job is done when `node scripts/setup.mjs deploy` prints `DEPLOY_OK`, the person has added the connector in claude.ai, and one real question (e.g. "what's due this week?") works. `node scripts/e2e.mjs` printing `E2E_OK` also counts.

---

## Hard rules

1. **Never see, print, log, store or commit a secret.** Secrets are `CANVAS_API_TOKEN`, `GITHUB_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY` (and the person's passwords). The human pastes them into `scripts/set-secret.mjs` or `set-secret.ps1`, which send them straight to Cloudflare. Do not ask the person to paste a secret into chat. If they do anyway, don't repeat it; tell them to rotate it.
2. **Never type passwords or log in for the person.** Cloudflare login, GitHub login and Canvas token creation are theirs.
3. **Read-only stays read-only.** Every Canvas call goes through `canvasGet`/`canvasGetAll` in `src/canvas.ts`, which only issues `GET` to `/api/v1/...`. Don't add POST/PUT/DELETE, don't add a "raw request" tool, and don't add file downloads (Canvas file URLs are pre-signed and leak access).
4. **Never commit `wrangler.jsonc`.** It holds the school URL, GitHub username and KV id, and it's gitignored. `wrangler.example.jsonc` is the template.
5. **Keep the allowlist.** `ALLOWED_GITHUB_USERS` is checked at `/callback` (`src/github-handler.ts`) and on every `/mcp` request (`src/index.ts`). Never remove or bypass either check.

---

## What's in here

| Path | What it is |
|---|---|
| `src/index.ts` | Entry. `OAuthProvider` (from `@cloudflare/workers-oauth-provider`) wraps a stateless MCP handler at `/mcp`. Rejects tokens whose GitHub login isn't allowlisted. |
| `src/github-handler.ts` | `/authorize` (consent page), `/callback` (GitHub code exchange + allowlist check). From Cloudflare's `remote-mcp-github-oauth` template. |
| `src/workers-oauth-utils.ts`, `src/utils.ts` | Template OAuth helpers (CSRF, state, consent page HTML). `isAllowed()` lives in `utils.ts`. |
| `src/canvas.ts` | GET-only Canvas client: auth header, 15s timeout per request, `Link`-header pagination (max 10 pages, same origin only), HTML→text, timing logs. |
| `src/tools.ts` | The 10 MCP tools, all `readOnlyHint: true`. |
| `test/tools.test.mts` | Runs every tool against a fake Canvas over HTTP; asserts only GET is ever sent. `npm test`. |
| `scripts/setup.mjs` | `init` / `status` / `deploy`. Machine-friendly output, see below. |
| `scripts/set-secret.mjs` | Hidden-input prompt → `wrangler secret put`. Validates the Canvas token against Canvas first. **Needs a real TTY.** |
| `set-secret.ps1` | Windows GUI version of the same (always-on-top password box). Good when you can't give the human a TTY. |
| `scripts/e2e.mjs` | Real OAuth sign-in in the browser + calls tools against real Canvas. Prints counts only. |
| `wrangler.example.jsonc` | Config template. `setup.mjs init` writes the real `wrangler.jsonc`. |

Tools: `list_courses`, `get_grades`, `list_assignments`, `get_assignment`, `list_missing_work`, `list_upcoming`, `get_syllabus`, `list_modules`, `list_announcements`, `list_quizzes`.

Runtime config: vars `MCP_RESOURCE` (public URL + `/mcp`, tokens are bound to it), `CANVAS_BASE_URL`, `ALLOWED_GITHUB_USERS` (comma-separated). KV binding `OAUTH_KV`. Secrets `COOKIE_ENCRYPTION_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `CANVAS_API_TOKEN`.

---

## Runbook

`setup.mjs` exit codes: **0** ok, **1** error (message says why), **2** needs a human (line starts with `NEEDS A HUMAN:`). It's idempotent: rerunning `init` reuses the KV namespace and keeps the existing cookie key.

### 0. Gather two facts from the person (ask, don't guess)

- **Canvas URL**: what's in their browser when Canvas is open, e.g. `https://something.instructure.com` (origin only). Some schools use a custom domain; use whatever host serves `/api/v1`.
- **GitHub username** (not email). If they don't have GitHub, they need to make a free account first.

Optional: worker name (default `canvas-mcp`).

### 1. Prerequisites

```
node --version        # need >= 20
npm install
```

If `npm install` fails with an `ERESOLVE` peer dependency error about `@cloudflare/workers-types`, bump `@cloudflare/workers-types` in `package.json` to the major version wrangler asks for and reinstall.

### 2. Cloudflare login (human)

Check with `npx wrangler whoami`. If not logged in, run `npx wrangler login` and tell the person: "a browser tab will open, sign in to Cloudflare and click Allow". It opens a localhost callback and waits.

- If it fails with "Timed out waiting for authorization code", that's usually because they weren't signed in to the Cloudflare dashboard yet and the sign-in took too long. Have them sign in at dash.cloudflare.com first, then rerun `npx wrangler login`. Then it's one click.
- They need a Cloudflare account (free). If they have none, they make one at dash.cloudflare.com.

### 3. Init

```
node scripts/setup.mjs init --canvas-url <url> --github-user <user> [--name canvas-mcp]
```

If it exits 2 with "no workers.dev subdomain": **ask the person** what subdomain they want (it's public, part of every Worker URL on their account, e.g. `https://canvas-mcp.<subdomain>.workers.dev`; suggest something that isn't their real name), then rerun with `--subdomain <pick>`.

If their login has several Cloudflare accounts, it tells you to set `CLOUDFLARE_ACCOUNT_ID`; ask which one.

On success it prints `SETUP_RESULT {"url":...,"mcp":...,"callback":...}` and the exact GitHub OAuth App values.

### 4. GitHub OAuth App (human)

Tell the person to open https://github.com/settings/applications/new (signed in as the allowlisted user, or any account they own; the app owner doesn't have to be the allowlisted user) and enter:

- Application name: `Canvas MCP`
- Homepage URL: `<url>` from `SETUP_RESULT`
- Authorization callback URL: `<callback>` from `SETUP_RESULT`, exactly
- Enable Device Flow: unchecked

Then **Register application**. If you have browser automation and the person says OK, you may fill and submit this form for them. Don't click "Generate a new client secret" yourself, because the secret would be shown to you. The person does that.

### 5. Secrets (human pastes, you launch the prompt)

`COOKIE_ENCRYPTION_KEY` is already set by `init`. Three remain: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `CANVAS_API_TOKEN`.

The Client ID isn't secret (it appears in login URLs). If the person reads it to you, you may set it yourself: `printf '%s' '<id>' | npx wrangler secret put GITHUB_CLIENT_ID`.

The other two must go through a hidden prompt the person types into:

- **You have no TTY** (most agent shells don't). Open a separate visible window for the person:
  - Windows: `Start-Process powershell -ArgumentList '-NoProfile','-STA','-ExecutionPolicy','Bypass','-File','"<repo>\set-secret.ps1"','CANVAS_API_TOKEN' -WorkingDirectory '<repo>'`. **Don't pass `-WindowStyle Hidden`**: it also hides the form, so the person sees nothing. Windows 11 may host plain console windows inside Windows Terminal where they're easy to lose; the `.ps1` GUI box is always on top, so prefer it.
  - macOS: `osascript -e 'tell app "Terminal" to do script "cd <repo> && node scripts/set-secret.mjs CANVAS_API_TOKEN"'`
  - Linux: ask the person to run `node scripts/set-secret.mjs <NAME>` in a terminal.
- **The person is at a terminal**: they run `node scripts/set-secret.mjs <NAME>` themselves.

How the person gets each value:

- `GITHUB_CLIENT_SECRET`: on the OAuth App page, **Generate a new client secret** (GitHub may ask for 2FA), copy it immediately (shown once).
- `CANVAS_API_TOKEN`: Canvas → Account → Settings → Approved Integrations → **+ New Access Token** → purpose "Claude" → Generate. Copy the full token from the popup (about 70 chars, contains `~`). The list on the settings page shows a truncated version, which is useless. Both prompts check the token against `<CANVAS_BASE_URL>/api/v1/users/self` and refuse to save a bad one, telling them the pasted length.

Confirm with `node scripts/setup.mjs status` (all `[x]` except "deployed" before the first deploy). `wrangler secret list` shows names only, never values.

Some schools disable personal access tokens. If Canvas has no "+ New Access Token" button, this project can't work for that school without an admin-issued developer key. Tell the person that plainly.

### 6. Deploy

```
node scripts/setup.mjs deploy
```

Checks secrets, deploys, then smoke-tests: unauthenticated `POST /mcp` → 401, `/.well-known/oauth-protected-resource/mcp` → `resource` equals `MCP_RESOURCE`, `/register` → 201. Prints `DEPLOY_OK {"connector_url": ...}`.

### 7. Verify with real data (human clicks twice)

Either:

- `node scripts/e2e.mjs`: opens the sign-in page in the default browser. The person clicks **Approve**, then **Authorize** on GitHub. Prints counts per tool and `E2E_OK`. Don't report the person's actual grades unless they ask.
- Or skip straight to step 8 and ask a real question.

### 8. Add to claude.ai (human)

claude.ai (web) → Settings → Connectors → **Add custom connector**:

- Name: anything (e.g. `Canvas`)
- URL: `connector_url` from `DEPLOY_OK`. **Must end in `/mcp`.**
- Authentication: **Sign in now**. OAuth client: **Register automatically** (DCR). Don't pick "Use Claude's published identity" (CIMD isn't enabled here). Transport: **Streamable HTTP**. No custom headers.
- Connect → Approve → Authorize.

On the phone, it syncs automatically; the person toggles it on in a chat's tools menu.

---

## Debugging

Live logs: `npx wrangler tail <name> --format json`. Each event is **multi-line pretty JSON**, so don't parse it line by line. Useful log lines this code emits:

- `canvas START GET <path>`, then `canvas <status> <ms>ms GET <path>`
- `canvas FETCH-FAIL ...` (network/timeout to Canvas)
- `tool ok <ms>ms, <n> chars` / `tool error: ...`

| Symptom | Cause / fix |
|---|---|
| Tool returns "Canvas token is invalid or expired" | `CANVAS_API_TOKEN` is wrong/expired/deleted. Human makes a new one, sets it via the prompt. No redeploy needed. |
| GitHub sign-in ends at "This server is private." (403) | Signed-in GitHub user isn't in `ALLOWED_GITHUB_USERS`. Fix the var (rerun `init` with the right `--github-user`) and `deploy`. |
| claude.ai connector "failed to connect" | URL missing `/mcp`; or `MCP_RESOURCE` doesn't match the real host (the protected-resource metadata then 404s; it's served at the path derived from `MCP_RESOURCE`, on that exact host). Run `status`. |
| `POST /mcp -> canceled` in tail with **no** `canvas START` | Harmless: the client closed a streamed response. |
| `canceled` **after** `canvas START` with no matching status line | Canvas was slow/hung. The 15s per-request timeout returns a readable error instead. |
| GitHub callback error / "redirect_uri mismatch" | OAuth App callback URL must be exactly `<url>/callback`. |
| `wrangler deploy` says required secrets missing | Expected until step 5 is done. |
| `wrangler login` times out | See step 2. |
| Local `wrangler dev` metadata 404 | You're hitting `127.0.0.1` but `MCP_RESOURCE` says `localhost` (or vice versa). Hosts must match. |

Local dev: create `.dev.vars` (gitignored) with dummy values for the four secrets and run `npm run dev` with `MCP_RESOURCE` pointing at `http://localhost:8788/mcp`. Real OAuth won't complete locally without a second GitHub OAuth App whose callback is `http://localhost:8788/callback`.

---

## Changing things

- **Add a tool**: in `src/tools.ts`, use `canvasGet`/`canvasGetAll` only, wrap with `wrap()`, set `annotations: RO`, keep output small (use `pick()`, `stripHtml()`). Add a case to the fake server in `test/tools.test.mts` and an assertion; the test fails if any non-GET request is made or a tool lacks `readOnlyHint`. Then `npm run type-check && npm test && npm run deploy`.
- **Change allowlist / Canvas URL**: rerun `init` with new flags, then `deploy`.
- **Rotate the Canvas token**: new token via the prompt; delete the old one in Canvas.
- **Rotate the GitHub secret**: generate a new one on the OAuth App page, set it, delete the old one on GitHub.
- **Types** after changing vars/bindings: `npm run cf-typegen` (generates from the example config with loose string types, so no personal values end up in git).

## Removing it

`npx wrangler delete <name>`, delete the KV namespace (`npx wrangler kv namespace list` / `delete`), delete the GitHub OAuth App, delete the Canvas token, remove the claude.ai connector.

## Costs and limits

Cloudflare Workers free plan (100k requests/day) and KV free tier are far beyond what one student uses. No Durable Objects. Each tool call is one to a few Canvas API requests; pagination is capped at 10 pages of 100.
