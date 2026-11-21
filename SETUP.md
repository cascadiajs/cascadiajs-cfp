# CascadiaJS CFP: setup and operations

How the CascadiaJS 2027 Call for Presenters at [cfp.cascadiajs.com](https://cfp.cascadiajs.com) is built, configured, run and deployed. For how presenters connect their agent and submit talks, see the [README](README.md).

## How it's built

The site is hosted on Netlify:

| Path | What it serves |
| --- | --- |
| `/` | `public/index.html`, a static page explaining how to connect an agent |
| `/styles.css` | Shared page styles matching [cascadiajs.com](https://github.com/cascadiajs/cascadiajs); fonts come from the CascadiaJS Adobe Fonts kit `nln6hzq` |
| `/mcp` | A stateless MCP server (Streamable HTTP) that requires [sign-in with Auth0](#sign-in-with-auth0), `netlify/functions/mcp.ts` |
| `/.well-known/oauth-protected-resource[/mcp]` | Tells agents to sign in with Auth0, `netlify/functions/well-known.ts` |
| `/record` | Fallback [video recorder](#video-recording) page, `netlify/functions/record.ts` |
| `/submit` | [Website submissions](#website-submissions): the same forms as the agent, for presenters who'd rather not use one, `netlify/functions/submit.ts` |
| `/auth/login`, `/auth/callback`, `/auth/logout` | [Website sign-in](#website-sign-in) with Auth0, `netlify/functions/auth.ts` |
| `/api/profile`, `/api/submissions` | The endpoints `/submit` saves profiles and talks through (session cookie), `netlify/functions/api.ts` |
| `/api/recordings/*` | The two endpoints the recorder on `/record` and `/submit` uploads through (recording token), `netlify/functions/api.ts` |

Submitting through an agent is the primary way and the website is the secondary one. Both end in the same CFP functions (`netlify/lib/cfp.ts`) with the same schemas, keyed by the presenter's verified email, so a presenter sees the same profile and talks in both.

## Sign-in with Auth0

The MCP server uses [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) (OAuth 2.1), with [Auth0](https://auth0.com) as the authorization server. This app runs no sign-in code of its own:

1. A request to `/mcp` without a valid access token gets a `401`. Its `WWW-Authenticate` header points to `/.well-known/oauth-protected-resource/mcp`, which names the Auth0 tenant.
2. The agent registers itself with Auth0 and opens Auth0's sign-in page in the presenter's browser. The presenter signs in with their email and a one-time code.
3. Auth0 issues an access token for this server's API. The agent keeps it and sends it with every request; the model never sees it.
4. The server checks the token against the tenant's published keys (`netlify/lib/auth/tokens.ts`), with the same rules as Auth0's own verifier: RS256 signature, issuer, audience, and required `iat`, `exp` and `sub` claims, plus a client (`azp`). It then reads the presenter's verified email from the `https://cfp.cascadiajs.com/email` claim.

Presenters are keyed by that email, not by their Auth0 user ID. Signing in proves they own the address, so there's no separate verification step and no API key.

### Website sign-in

`/submit` signs presenters in with a second Auth0 application in the same tenant, the "website" application (a Regular Web Application), using the authorization code flow with PKCE. Presenters see the same passwordless email sign-in as in agents.

1. **Sign in** on `/submit` goes to `/auth/login`, which stores the sign-in's state, nonce and PKCE verifier in a signed, 10-minute cookie and redirects to Auth0.
2. Auth0 sends the presenter back to `/auth/callback`. The server checks the state, exchanges the code for an ID token (with the application's client secret) and verifies it (`verifyIdToken` in `netlify/lib/auth/tokens.ts`): RS256 signature, issuer, the application as audience, the nonce, and a verified `email`.
3. It sets `cfp_session`, a signed (HS256 with `SESSION_SECRET`), HttpOnly, `SameSite=Lax` cookie holding that email for 7 days (`netlify/lib/auth/session.ts`).
4. The page's API requests act for that email. They also check the `Origin` header and require JSON, so other sites can't make them. **Sign out** (`POST /auth/logout`) clears the cookie and ends the Auth0 session.

The website never sees or stores an access token: it only needs the presenter's verified email. Without `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` and `SESSION_SECRET`, `/submit` says website submissions aren't available, and agents are unaffected.

### Auth0 setup

Follow [AUTH0.md](AUTH0.md). It has step-by-step instructions, with the exact values for the development tenant (`http://localhost:8888/mcp`) and the production tenant (`https://cfp.cascadiajs.com/mcp`). In short, each tenant needs:
- an API whose identifier equals that environment's MCP URL;
- third-party access to that API;
- the Resource Parameter Compatibility Profile and Client ID Metadata Document registration;
- a domain-level passwordless email connection, with the Identifier First authentication profile;
- the post-login Action from [`auth0/post-login-email-claim.js`](auth0/post-login-email-claim.js).

For website sign-in, the tenant also needs a Regular Web Application with `/auth/callback` as its callback URL and the email connection enabled (AUTH0.md, step 9).

Agents read the server's `instructions` and tool descriptions when they connect (see `instructions` in `netlify/functions/mcp.ts`), so reconnect after changing them.

## MCP tools

- `create-profile` saves the signed-in presenter's profile, which `submit-cfp` requires. Every field is optional: if required ones are missing, it shows the [profile form](#profile-form).
- `submit-cfp` saves a talk for the signed-in presenter, once per talk. Every talk field is optional: if any are missing, it shows the [submission form](#submission-form); without a video URL it then shows the [video recorder](#video-recording).
- `list-submissions` lists the signed-in presenter's talks, newest first, with each talk's review `status` and each video's status: `attached`, `processing`, `awaiting_recording`, `failed` (with `video_error`) or `missing` (the 24-hour recording window closed without a video). It returns `structuredContent: { submissions }` and is read-only.
- `save-profile` (called by the profile form), `create-submission` (called by the submission form), and `create-video-upload` and `attach-video` (called by the recorder) are for the apps, not the model (`_meta.ui.visibility: ["app"]`). On the website, the same forms make the same calls through REST endpoints instead (see [Website submissions](#website-submissions)).

Every tool acts for the presenter whose email the access token carries. Recording tools additionally check that the recording belongs to that presenter; the standalone recorder uses its scoped recording token. The CFP logic is in `netlify/lib/cfp.ts`.

The server offers one of two versions, depending on whether the agent declares MCP Apps support (`io.modelcontextprotocol/ui` with `text/html;profile=mcp-app`) when it connects:

- **With MCP Apps:** tools declare their `ui://` resources, the app-only tools are registered, and results tell the model a form is showing so it doesn't repeat the fields in chat.
- **Without:** no resources and no app-only tools. Results list missing details for the model to collect in chat, and the video is recorded through the `record_url` link.

The server is stateless, so it carries the choice in the `Mcp-Session-Id` it returns from `initialize` (prefixed `ui.` or `text.`), which agents send back on every request. An agent that sends no session id gets the text version.

## Profile form

When `create-profile` can't complete the profile from what's saved plus what the agent passed, it saves nothing and returns `structuredContent: { status: "needs_details", email_address, prefill }`. In agents that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps), `create-profile` declares `_meta.ui.resourceUri: "ui://cascadiajs-cfp/profile"`, so the result shows a form (`netlify/lib/profile.ts`) pre-filled with the saved and passed details. The email comes from sign-in and isn't editable. Submitting it calls `save-profile` and tells the agent with `ui/update-model-context`. Once the profile is complete, results carry `status: "profile_complete"`.

Agents that can't show MCP Apps get a result that lists the missing details (`structuredContent` adds `missing`) and tells them to ask for them and call `create-profile` again with all of them. A call that completes the profile saves it immediately.

## Submission form

`submit-cfp` first checks that the presenter's profile is complete, so it fails before any form appears if `create-profile` hasn't been run. Without every talk field, it saves nothing and returns `structuredContent: { status: "needs_details", prefill }` (plus `missing` for agents without MCP Apps), and agents that support MCP Apps show the submission form (`netlify/lib/submission.ts`, resource `ui://cascadiajs-cfp/submission`). The form is pre-filled with the agent's drafts and has a character counter for the description and a choice between recording the video now or giving a link. Submitting calls `create-submission`. Unless a link was given, the same app then switches to the [video recorder](#video-recording).

With every talk field, `submit-cfp` saves the talk straight away and the app goes directly to the recorder.

## Video recording

When `submit-cfp` is called without `video_submission_url`, the submission is saved without a video and the result carries a recording token that expires after 24 hours. The presenter records the video in the browser, which uploads it straight to [Mux](https://www.mux.com), and the submission's `video_submission_url` becomes a `https://player.mux.com/<playback id>` link. Videos are public but unlisted, like the unlisted YouTube links the CFP already accepts.

The recorder (`netlify/lib/recorder.ts`) runs in two places. It shares its host bridge and styles with the forms (`netlify/lib/app.ts`):

- **In the agent**, as the last step of the submit-cfp [MCP App](https://github.com/modelcontextprotocol/ext-apps) (`ui://cascadiajs-cfp/submission`), whose resource asks the host for camera and microphone access. It gets the recording token from the saved submission and calls `create-video-upload` and `attach-video` through the host.
- **At `/record#token=…`**, for agents that don't show MCP Apps or that block the camera. The tool result's text always includes this link, and the in-agent recorder offers to open it. The token sits in the URL fragment, so it is never sent to the server in a request line or logged. This page uploads through two REST endpoints that accept only the recording token:

| Method and path | Auth | Success |
| --- | --- | --- |
| `POST /api/recordings/upload` | `Authorization: Bearer <recording_token>` | `200 { upload_url }` (a Mux direct-upload URL to `PUT` the video to) |
| `POST /api/recordings/complete` | `Authorization: Bearer <recording_token>` | `200 { submission_id, video_url }`, or `409` while Mux is still processing |

Recording stops automatically at 2:00. Uploads go directly from the browser to Mux, since Netlify Functions cap request bodies at about 6 MB.

### Upload abuse protection

The initial migration `0001_init.sql` includes the recording expiry fields and upload tracking. Quotas are counted from `submissions.upload_reserved_at`, so they need no separate table.

- One Mux upload allocation per submission, reserved in a database transaction before contacting Mux. Concurrent calls and retries reuse that upload. An ambiguous creation failure consumes the allocation instead of retrying a potentially successful paid operation.
- Per presenter: **5 uploads per UTC day, 20 total**. New submissions do not reset the quota.
- Across the site: **100 uploads per UTC day, 1,000 total**, configurable with `VIDEO_UPLOADS_DAILY_LIMIT` and `VIDEO_UPLOADS_TOTAL_LIMIT`. Set either to `0` to stop issuing new upload URLs. Failed uploads still count; deleting a submission frees its upload. Reservations take a transaction-scoped advisory lock, so concurrent calls can't both pass the count.
- Recording tokens expire after **24 hours**; Mux upload URLs expire after **15 minutes**. Completed tokens permit read-only completion retries until expiry, but cannot allocate another upload.
- Newly uploaded media has no playback ID until Mux reports a ready video track and a positive duration of at most **125 seconds** (the recorder stops at 120 seconds; five seconds allow browser timing drift). Invalid media is deleted.
- A Mux webhook (`/webhooks/mux`, `netlify/functions/mux-webhook.ts`) attaches successful videos even if the browser closes. When Mux reports a video ready or failed, or an upload failed or cancelled, it runs the same check as the recorder: it attaches a valid video and deletes an invalid one, recording why. Requests must carry a valid `Mux-Signature` made with `MUX_WEBHOOK_SECRET`. Other events are ignored without touching the database. While a video is still processing or another check of it is under way, it answers 503 and Mux retries, for up to 24 hours. Failures show in the webhook's delivery log in the Mux dashboard.
- Mux sends nothing when an unused upload link times out. Nothing was uploaded, so there's nothing to clean up: `list-submissions` reports an upload with no result after an hour as missing a video. Expired recording tokens stay in the database but are rejected, since every lookup checks the expiry.
- Upload retries skip the file transfer once it succeeded. Server completion is idempotent, and overlapping validation calls share a database lease.

Mux direct uploads do **not** provide an application-specific byte or duration limit before ingestion. Validation and deletion happen after ingestion, so initial processing may incur charges. The global caps bound upload counts, not dollars; set them to an acceptable exposure and configure provider billing alerts. Enforcing byte/duration limits before any Mux processing would require a separate upload staging and media inspection service.

There's no scheduled job: a job that queried the database every few minutes kept Netlify DB from ever pausing, and its compute was billed around the clock. Mux can't reach a local server, so locally the recorder's own completion call attaches videos. Use a separate Mux environment for development.

**Mux webhook setup.** In the Mux dashboard for the production environment, go to Settings → Webhooks, create a webhook with the URL `https://cfp.cascadiajs.com/webhooks/mux`, and copy its signing secret into the `MUX_WEBHOOK_SECRET` environment variable in Netlify.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `AUTH0_DOMAIN` | Yes | The Auth0 tenant domain (for example `cascadiajs.us.auth0.com`) or your Auth0 custom domain |
| `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` | For `/submit` | The Client ID and Client Secret of the Auth0 website application, for [website sign-in](#website-sign-in) |
| `SESSION_SECRET` | For `/submit` | At least 32 random characters (for example `openssl rand -base64 32`) that sign the website's session cookie. Changing it signs everyone out of the website |
| `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET` | Yes | A Mux access token with Mux Video read and write permissions (including deletion), for recorded videos |
| `MUX_WEBHOOK_SECRET` | Yes, in production | The signing secret of the Mux webhook that points at `/webhooks/mux` (see [Mux webhook setup](#upload-abuse-protection)) |
| `VIDEO_UPLOADS_DAILY_LIMIT`, `VIDEO_UPLOADS_TOTAL_LIMIT` | No | Global upload allocation caps; defaults 100 per UTC day and 1,000 total. Zero disables new allocations. |
| `POSTHOG_KEY` | No | PostHog project API key (US Cloud) for [analytics](#analytics). Without it, nothing is sent. Set it for the Production context only, so previews and local development don't send events. |

For local development, copy `.env.example` to `.env.local` (git ignores it) and fill in the values; `netlify dev` loads it at startup. Without `AUTH0_DOMAIN`, `/mcp` answers with a configuration error. Without the three website variables, `/submit` says website submissions aren't available.

## Analytics

[PostHog](https://posthog.com) (US Cloud) is on when `POSTHOG_KEY` is set. The code is in `netlify/lib/analytics.ts`.

**Web pages.** `public/index.html` and the server-rendered pages (`netlify/lib/page.ts`, such as `/record`) load `/analytics.js` (`netlify/functions/analytics.ts`), which serves PostHog's snippet with the key, or an empty script without one. It captures pageviews and autocaptured clicks:

- **No cookies:** `cookieless_mode: "always"` sets no cookies and uses no browser storage, so no consent banner is needed. PostHog counts unique visitors with a hash on its servers. **Turn on cookieless mode in the PostHog project settings**, or PostHog ignores these events.
- **No URL fragments:** `before_send` strips `#…` from every URL property, because the `/record` page carries its recording token in the fragment.
- **Reverse proxy:** the browser sends events to `https://g.cascadiajs.com`, PostHog's managed reverse proxy (a Cloudflare CNAME), so ad blockers don't drop them. The snippet also loads PostHog's library from there, and `ui_host` points links to the PostHog app at `https://us.posthog.com`. Server-side events go straight to `us.i.posthog.com`; ad blockers don't see them.
- Session recording is off. The MCP App forms shown inside agents don't load analytics.

**Server-side events.** Most of the CFP happens inside agents, so the server sends these with `posthog-node`:

| Event | When | Properties |
| --- | --- | --- |
| `mcp_connected` | A signed-in agent connects (MCP `initialize`) | `client_name`, `client_version`, `protocol_version` |
| `mcp_tool_called` | Any tool call | `tool`; `called_by`: `model` or `app` (the forms' own tools); `outcome`: `error`, `ok` or the result's status, such as `needs_details`, `profile_complete` or `submitted` |
| `profile_completed` | A presenter's profile is saved complete for the first time (chat or form) | |
| `profile_updated` | A complete profile is saved again | |
| `talk_submitted` | A talk is saved (chat or form) | `submission_id`, `video`: `link` or `recording` |
| `video_attached` | A recorded video passes validation and is attached, by the recorder or the Mux webhook | `submission_id`, `video` |
| `video_failed` | A recording is rejected | `submission_id`, `reason`: `expired`, `upload_failed` or `invalid_video` |
| `web_signed_in` | A presenter signs in on `/submit` | |

Events from MCP requests have `channel: "mcp"`; `web_signed_in` and the profile and talk events from `/submit` have `channel: "web"`. Every event sent during an MCP request also has `mcp_client`, the agent's name as it says in `initialize` (lowercased, such as `claude-ai`), and `mcp_apps`, whether it shows the forms. The server is stateless, so both ride in the session id it returns from `initialize` (`ui.claude-ai.<uuid>`). Events from the website, the recorder's upload endpoints and the Mux webhook don't have them.

Events are tied to `profile_<id>`, never the email, with no person profile (`$process_person_profile: false`) and no IP-based location (the IP would be Netlify's). A PostHog failure is logged and never fails the request. The `mcp_*` events are sent after the response, so agents don't wait for them; the CFP events are sent before it, with a 3-second timeout. Sign-ins that fail at Auth0 never reach the server: see the Auth0 logs for those. Web visitors and presenters aren't linked: the pages are anonymous and the CFP happens in agents.

**CFP funnel.** In PostHog, create a new insight of type **Funnel** with the steps `mcp_connected` → `profile_completed` → `talk_submitted` → `video_attached`, a 14-day conversion window, and breakdown by the event property `mcp_client` (attribution: first step). Save it to a dashboard. For the website, use `web_signed_in` → `profile_completed` → `talk_submitted` with breakdown by `channel`. A funnel of `mcp_tool_called` filtered by `tool` and `outcome` shows where presenters stall, for example `submit-cfp` with `outcome = needs_details` and no `talk_submitted` after it.

## Run locally

```sh
npm install
npm run dev
```

The first time, apply the migrations to the local database (see [Database](#database)): `npx netlify database migrations apply`.

Netlify Dev serves the site at `http://localhost:8888/`, the website form at `http://localhost:8888/submit` and the MCP endpoint at `http://localhost:8888/mcp`, whose tokens must be issued for the `http://localhost:8888/mcp` API in Auth0 (see [Auth0 setup](#auth0-setup)). Connect an MCP client or the MCP Inspector; it will walk through sign-in. In development, the server also logs one `[mcp]` line per MCP request, with the signed-in email.

## Deploy

The site deploys from Git, the same way as [cascadiajs/cascadiajs](https://github.com/cascadiajs/cascadiajs):

- Create a branch from `main` and open a PR into `main`. Commit messages use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`).
- GitHub Actions (`.github/workflows/tests.yml`) type-checks every push and PR to `main`. CI must be green before merge.
- Netlify builds every PR as a deploy preview and deploys `main` to production. The build command and Node version are in `netlify.toml`; the build runs the same type check, so a type error also stops the deploy. Migrations in `netlify/database/migrations/` are applied as part of the deploy.

Deploy previews and branch deploys serve the static page, but sign-in doesn't work there: the Auth0 API identifier is `https://cfp.cascadiajs.com/mcp`, the website application only allows `https://cfp.cascadiajs.com/auth/callback`, and a preview's hostname is different. Test sign-in locally against the development tenant, or in production.

To deploy from your machine anyway, for example while Git deploys are paused, run `npx netlify deploy --prod`.

The site is served at `https://cfp.cascadiajs.com`: that custom domain is added to the Netlify site, with a DNS-only CNAME in Cloudflare pointing to `cascadiajs-cfp.netlify.app`. The token audience and links follow the domain a request comes in on, so serve the site from a single domain matching the Auth0 API identifier. Tokens issued for one hostname aren't accepted on another. Set the [environment variables](#environment-variables) before the first production deploy.

## Website submissions

`/submit` is the secondary way to submit, for presenters who'd rather not use an agent. After [website sign-in](#website-sign-in), it shows the same forms in the same order as the MCP Apps: the [profile form](#profile-form) until the profile is complete, then the [submission form](#submission-form) followed by the [video recorder](#video-recording). Below them, it lists the presenter's talks with the same details and statuses as `list-submissions`. **Edit your profile** reopens the profile form, and **Submit another talk** starts the next talk.

### Shared components

Each form is one component: markup plus a script that defines a controller (`cfpProfileForm`, `cfpSubmissionForm`, `cfpRecorder`). The MCP App documents and the `/submit` page are built from the same exports:

| Component | Module | Exports |
| --- | --- | --- |
| Profile form | `netlify/lib/profile.ts` | `PROFILE_FORM_MARKUP`, `PROFILE_FORM_SCRIPT`, `PROFILE_FORM_STYLES` |
| Talk form and recorder | `netlify/lib/submission.ts` | `SUBMISSION_FORM_MARKUP`, `SUBMISSION_FORM_SCRIPTS`, `SUBMISSION_FORM_STYLES` |
| Recorder | `netlify/lib/recorder.ts` | `RECORDER_MARKUP`, `RECORDER_SCRIPT_BODY`, `RECORDER_STYLES` |
| Styles and transports | `netlify/lib/app.ts` | `APP_STYLES`, `FORM_STYLES`, `APP_BRIDGE_SCRIPT` (`mcpApp`), `SITE_API_SCRIPT` (`cfpSite`) |

The components never talk to the server directly. Whoever embeds them calls `connect({ callTool, ... })` with a function that takes a tool name and arguments and returns the tool's `structuredContent`:

- **In agents** (`PROFILE_APP_HTML`, `SUBMISSION_APP_HTML`), `mcpApp.callTool` calls the tool through the host. The MCP glue also opens the forms from the tool result and keeps the agent informed (`ui/update-model-context`, `ui/message`).
- **On the site** (`/submit` in `netlify/lib/submit-page.ts`, and `/record`), `cfpSite.callTool` sends the same calls to this site's API, which runs the same CFP functions and returns the same results:

| Tool | Website endpoint | Auth |
| --- | --- | --- |
| `save-profile` | `POST /api/profile` | Session cookie |
| `create-submission` | `POST /api/submissions` | Session cookie |
| `list-submissions` | `GET /api/submissions` (and rendered into `/submit`) | Session cookie |
| `create-video-upload` | `POST /api/recordings/upload` | Recording token |
| `attach-video` | `POST /api/recordings/complete` | Recording token |

A form change made in one of these modules shows up both in agents and on the website.

**Recording later.** The server keeps only a hash of each recording token, so `/submit` remembers the `/record` link of each talk that still needs a video in the browser's `localStorage`, and shows it as **Record it now** in the list until the video is attached or the link expires.

## Database

This project is linked to the `cascadiajs-cfp` Netlify site, which has a managed PostgreSQL database. Browse and edit its rows in the [Netlify database dashboard](https://app.netlify.com/projects/cascadiajs-cfp/database).

The `@netlify/database` package is installed. In a Netlify Function, use `getDatabase()` to resolve the connection for the current environment automatically:

```ts
import { getDatabase } from "@netlify/database";

const db = getDatabase();
const rows = await db.sql`SELECT 1 AS connected`;
```

Use Node.js 22.12 or newer. `npm run dev` starts a separate local database. Add schema migrations under `netlify/database/migrations/`; Netlify applies them on deploy. To apply migrations to the local database, run `npx netlify database migrations apply`.

### Tables

Migration `0001_init.sql` creates the profile and submission tables, based on the [CascadiaJS 2027 Call for Presenters form](https://docs.google.com/forms/d/e/1FAIpQLSdMtL6Qn5G6OBsL545UwJoxeLnxpSntAX06wylObHfkUhAhUQ/viewform):

- `public.profiles`: one row per presenter, keyed by the verified email from their Auth0 token (case-insensitive), created on their first request. The profile fields stay null until `create-profile` or the profile form sets `profile_completed_at`.
- `public.submissions`: one row per talk, with `talk_title`, `talk_description`, `topics`, `video_submission_url`, `submitted_at`, and `profile_id`, a foreign key to `profiles`.
  - `status` is the review decision: `under_review` when submitted, then `accepted`, `rejected` or `waitlist`, set by the organizers in the database. A `CHECK` constraint allows only those four values.
  - `video_submission_url` is null until a video is attached.
  - `recording_token_hash` and `mux_upload_id` track a recording in progress.
  - Deleting a profile deletes its submissions.

Netlify applies this initial migration on the first deploy. If a local development database already applied an earlier version, editing the migration does not update that database: recreate a disposable local database before applying the consolidated schema.
