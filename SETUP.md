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
| `/api/recordings/*` | The two endpoints the `/record` page uploads through, `netlify/functions/api.ts` |

Profiles and talks are only created through the MCP server; there is no REST API for them.

## Sign-in with Auth0

The MCP server uses [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) (OAuth 2.1), with [Auth0](https://auth0.com) as the authorization server. This app runs no sign-in code of its own:

1. A request to `/mcp` without a valid access token gets a `401`. Its `WWW-Authenticate` header points to `/.well-known/oauth-protected-resource/mcp`, which names the Auth0 tenant.
2. The agent registers itself with Auth0 and opens Auth0's sign-in page in the presenter's browser. The presenter signs in with their email and a one-time code.
3. Auth0 issues an access token for this server's API. The agent keeps it and sends it with every request; the model never sees it.
4. The server checks the token against the tenant's published keys (`netlify/lib/auth/tokens.ts`), with the same rules as Auth0's own verifier: RS256 signature, issuer, audience, and required `iat`, `exp` and `sub` claims, plus a client (`azp`). It then reads the presenter's verified email from the `https://cfp.cascadiajs.com/email` claim.

Presenters are keyed by that email, not by their Auth0 user ID. Signing in proves they own the address, so there's no separate verification step and no API key.

### Auth0 setup

Follow [AUTH0.md](AUTH0.md). It has step-by-step instructions, with the exact values for the development tenant (`http://localhost:8888/mcp`) and the production tenant (`https://cfp.cascadiajs.com/mcp`). In short, each tenant needs:
- an API whose identifier equals that environment's MCP URL;
- third-party access to that API;
- the Resource Parameter Compatibility Profile and Client ID Metadata Document registration;
- a domain-level passwordless email connection, with the Identifier First authentication profile;
- the post-login Action from [`auth0/post-login-email-claim.js`](auth0/post-login-email-claim.js).

Agents read the server's `instructions` and tool descriptions when they connect (see `instructions` in `netlify/functions/mcp.ts`), so reconnect after changing them.

## MCP tools

- `create-profile` saves the signed-in presenter's profile, which `submit-cfp` requires. Every field is optional: if required ones are missing, it shows the [profile form](#profile-form).
- `submit-cfp` saves a talk for the signed-in presenter, once per talk. Every talk field is optional: if any are missing, it shows the [submission form](#submission-form); without a video URL it then shows the [video recorder](#video-recording).
- `list-submissions` lists the signed-in presenter's talks, newest first, with each talk's review `status` and each video's status: `attached`, `processing`, `awaiting_recording`, `failed` (with `video_error`) or `missing` (the 24-hour recording window closed without a video). It returns `structuredContent: { submissions }` and is read-only.
- `save-profile` (called by the profile form), `create-submission` (called by the submission form), and `create-video-upload` and `attach-video` (called by the recorder) are for the apps, not the model (`_meta.ui.visibility: ["app"]`).

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
- `recording-cleanup` runs every five minutes on published Netlify deploys, checking up to ten pending uploads per run. It validates and attaches successful videos even if the browser closes, deletes invalid/expired assets, cancels expired pending uploads, and clears expired recording tokens. Failed provider calls remain eligible for later cleanup; monitor this function's failures.
- Upload retries skip the file transfer once it succeeded. Server completion is idempotent, and overlapping validation calls share a database lease.

Mux direct uploads do **not** provide an application-specific byte or duration limit before ingestion. Validation and deletion happen after ingestion, so initial processing may incur charges. The global caps bound upload counts, not dollars; set them to an acceptable exposure and configure provider billing alerts. Enforcing byte/duration limits before any Mux processing would require a separate upload staging and media inspection service.

Scheduled functions only run automatically on published deploys. For local development or previews, invoke `recording-cleanup` explicitly through Netlify's function tooling. No public cleanup endpoint or webhook secret is required. Use a separate Mux environment for development.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `AUTH0_DOMAIN` | Yes | The Auth0 tenant domain (for example `cascadiajs.us.auth0.com`) or your Auth0 custom domain |
| `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET` | Yes | A Mux access token with Mux Video read and write permissions (including deletion), for recorded videos |
| `VIDEO_UPLOADS_DAILY_LIMIT`, `VIDEO_UPLOADS_TOTAL_LIMIT` | No | Global upload allocation caps; defaults 100 per UTC day and 1,000 total. Zero disables new allocations. |
| `POSTHOG_KEY` | No | PostHog project API key (US Cloud) for [analytics](#analytics). Without it, nothing is sent. Set it for the Production context only, so previews and local development don't send events. |

For local development, copy `.env.example` to `.env.local` (git ignores it) and fill in the values; `netlify dev` loads it at startup. Without `AUTH0_DOMAIN`, `/mcp` answers with a configuration error.

## Analytics

[PostHog](https://posthog.com) (US Cloud) is on when `POSTHOG_KEY` is set. The code is in `netlify/lib/analytics.ts`.

**Web pages.** `public/index.html` and the server-rendered pages (`netlify/lib/page.ts`, such as `/record`) load `/analytics.js` (`netlify/functions/analytics.ts`), which serves PostHog's snippet with the key, or an empty script without one. It captures pageviews and autocaptured clicks:

- **No cookies:** `cookieless_mode: "always"` sets no cookies and uses no browser storage, so no consent banner is needed. PostHog counts unique visitors with a hash on its servers. **Turn on cookieless mode in the PostHog project settings**, or PostHog ignores these events.
- **No URL fragments:** `before_send` strips `#…` from every URL property, because the `/record` page carries its recording token in the fragment.
- Session recording is off. The MCP App forms shown inside agents don't load analytics.

**Server-side CFP events.** Most of the CFP happens inside agents, so the server sends these with `posthog-node`:

| Event | When | Properties |
| --- | --- | --- |
| `profile_completed` | A presenter's profile is saved complete for the first time (chat or form) | |
| `profile_updated` | A complete profile is saved again | |
| `talk_submitted` | A talk is saved (chat or form) | `submission_id`, `video`: `link` or `recording` |
| `video_attached` | A recorded video passes validation and is attached, by the recorder or the cleanup job | `submission_id`, `video` |
| `video_failed` | A recording is rejected | `submission_id`, `reason`: `expired`, `upload_failed` or `invalid_video` |

Events are tied to `profile_<id>`, never the email, with no person profile (`$process_person_profile: false`) and no IP-based location (the IP would be Netlify's). Each is sent before the request returns, with a 3-second timeout; a PostHog failure is logged and never fails the request. Web visitors and presenters aren't linked: the pages are anonymous and the CFP happens in agents.

## Run locally

```sh
npm install
npm run dev
```

Netlify Dev serves the site at `http://localhost:8888/` and the MCP endpoint at `http://localhost:8888/mcp`, whose tokens must be issued for the `http://localhost:8888/mcp` API in Auth0 (see [Auth0 setup](#auth0-setup)). Connect an MCP client or the MCP Inspector; it will walk through sign-in. In development, the server also logs one `[mcp]` line per MCP request, with the signed-in email.

## Deploy

The site deploys from Git, the same way as [cascadiajs/cascadiajs](https://github.com/cascadiajs/cascadiajs):

- Create a branch from `main` and open a PR into `main`. Commit messages use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`).
- GitHub Actions (`.github/workflows/tests.yml`) type-checks every push and PR to `main`. CI must be green before merge.
- Netlify builds every PR as a deploy preview and deploys `main` to production. The build command and Node version are in `netlify.toml`; the build runs the same type check, so a type error also stops the deploy. Migrations in `netlify/database/migrations/` are applied as part of the deploy.

Deploy previews and branch deploys serve the static page, but sign-in doesn't work there: the Auth0 API identifier is `https://cfp.cascadiajs.com/mcp`, and a preview's hostname is different. Test sign-in locally against the development tenant, or in production.

To deploy from your machine anyway, for example while Git deploys are paused, run `npx netlify deploy --prod`.

The site is served at `https://cfp.cascadiajs.com`: that custom domain is added to the Netlify site, with a DNS-only CNAME in Cloudflare pointing to `cascadiajs-cfp.netlify.app`. The token audience and links follow the domain a request comes in on, so serve the site from a single domain matching the Auth0 API identifier. Tokens issued for one hostname aren't accepted on another. Set the [environment variables](#environment-variables) before the first production deploy.

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
