import type { Config } from "@netlify/functions";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { appResourceMeta, MCP_APP_MIME_TYPE } from "../lib/app.js";
import { authConfig, type AuthConfig } from "../lib/auth/config.js";
import { verifyAccessToken } from "../lib/auth/tokens.js";
import {
  attachVideo,
  CfpError,
  completedProfile,
  createVideoUpload,
  listSubmissions,
  partialProfileShape,
  partialSubmissionShape,
  profileSchema,
  profileShape,
  recordingShape,
  saveProfile,
  savedProfile,
  submissionSchema,
  submissionShape,
  profileForEmail,
  submitCfp,
} from "../lib/cfp.js";
import { PROFILE_APP_HTML } from "../lib/profile.js";
import { SUBMISSION_APP_HTML } from "../lib/submission.js";

// The MCP server. Every request must carry an Auth0 access token (MCP authorization):
// agents discover Auth0 from the 401 below, sign the presenter in once, and keep the
// token themselves. The tools act for the presenter whose verified email the
// token carries, so no credential ever passes through the conversation.

// MCP Apps (io.modelcontextprotocol/ui) shown in agents that support them: create-profile
// shows the profile form, submit-cfp the talk form followed by the video recorder.
// Agents without MCP Apps get a text-only server instead: no UI resources, no app-only
// tools, and results that tell the model to collect the details in chat.
const PROFILE_URI = "ui://cascadiajs-cfp/profile";
const SUBMISSION_URI = "ui://cascadiajs-cfp/submission";
const UI_EXTENSION = "io.modelcontextprotocol/ui";

// Sent to agents on initialize; hosts such as Claude add it to the model's instructions.
const instructions = (ui: boolean) => `This server handles submissions to the CascadiaJS 2027 Call for Presenters (CFP): talk proposals for CascadiaJS 2027 in Seattle, WA, June 7-8, 2027. The CFP closes Jan 10, 2027.

The user signed in with their email when this server was connected, so you never need an API key, a password or their email address: every tool acts for the signed-in user.

When the user wants to submit, apply, propose a talk, or otherwise take part in the CascadiaJS 2027 CFP (for example "Help me submit a talk to the CascadiaJS 2027 CFP"):
${
  ui
    ? `1. Call create-profile right away, with no arguments or only profile details the user has already given you. Do not ask for their name, location or other details in chat first: create-profile shows a profile form for them to fill in, pre-filled with anything saved before. If their profile is already complete, it says so and you can move on.
2. Then call submit-cfp right away with any talk details the user has already given you (title, description under 280 characters, topics). Do not collect the talk details in chat first: submit-cfp shows a form for them to fill in or edit, then a recorder for their 2-minute video. If the user asks for help writing the details, draft them and pass the drafts to submit-cfp; the form lets them edit before submitting. Only pass video_submission_url if they already have a public link to their video. Call submit-cfp once per talk.
While a form is shown, keep your reply short: don't list the form's fields or what comes next, and don't ask for those details in chat.`
    : `1. Call create-profile right away, with no arguments or only profile details the user has already given you. If their profile is already complete, it says so and you can move on. Otherwise its result lists the missing details: ask the user for them in chat and call create-profile again with all of them.
2. Then help the user with their talk details (title, description under 280 characters, topics) and call submit-cfp with all of them. Pass video_submission_url only if they already have a public link to their video; otherwise the result gives a link where they record their 2-minute video in their browser, so share it with them. Call submit-cfp once per talk.`
}

When the user asks what they've already submitted, whether a talk was accepted, or whether its video went through, call list-submissions.`;

const FIELD_LABELS: Record<string, string> = {
  full_name: "full name",
  city: "city",
  country: "country",
  referral: "how they heard about the CFP",
  travel_covered: "whether their company can cover travel and lodging",
  confirmation: "confirmation that they can speak on June 7 or 8, 2027 in Seattle",
  talk_title: "talk title",
  talk_description: "talk description (fewer than 280 characters)",
  topics: "topics",
};

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

const failure = (tool: string, error: unknown) => {
  if (!(error instanceof CfpError)) console.error(`${tool} failed`, error);
  const message =
    error instanceof CfpError ? error.message : "Something went wrong. Please try again later.";
  return { isError: true, ...text(message) };
};

const describeMissing = (missing: string[]) =>
  missing.map((name) => (FIELD_LABELS[name] ? `${FIELD_LABELS[name]} (${name})` : name)).join(", ");

// The text the model gets when a form is shown: the form already lists and checks every
// field, so the model shouldn't repeat them in chat.
const FORM_SHOWN = (form: string, next: string) =>
  `The presenter now sees the ${form} with this result, pre-filled with what's known. Reply with one short sentence asking them to fill it in. Don't list its fields or ask for the details in chat. ${next}`;

const missingFields =(issues: { path: PropertyKey[] }[]) => [...new Set(issues.map((issue) => String(issue.path[0])))];

const profileSaved = (email: string) => ({
  ...text(`Profile saved for ${email}. Next, call submit-cfp to submit a talk.`),
  structuredContent: { status: "profile_complete", email_address: email },
});

type SubmitResult = Awaited<ReturnType<typeof submitCfp>>;
type Submission = Awaited<ReturnType<typeof listSubmissions>>[number];

const REVIEW_STATUS: Record<Submission["status"], string> = {
  under_review: "under review",
  accepted: "accepted",
  rejected: "not accepted",
  waitlist: "on the waitlist",
};

const VIDEO_STATUS: Record<Submission["video_status"], string> = {
  attached: "video attached",
  processing: "video uploaded and still processing",
  awaiting_recording: "video not recorded yet; use the recording link given when it was submitted",
  failed: "video failed",
  missing: "no video; the recording window closed. Submit the talk again with a video link or a new recording",
};

const describeSubmissions = (submissions: Submission[]) => {
  if (submissions.length === 0) return "No CascadiaJS 2027 CFP submissions yet. Call submit-cfp to submit a talk.";
  return [
    `${submissions.length} CascadiaJS 2027 CFP submission${submissions.length === 1 ? "" : "s"}, newest first:`,
    ...submissions.map((s) => {
      const video = [VIDEO_STATUS[s.video_status], s.video_url, s.video_error].filter(Boolean).join(": ");
      return [
        `- #${s.submission_id} "${s.talk_title}", submitted ${s.submitted_at}`,
        `  Status: ${REVIEW_STATUS[s.status]}`,
        `  Topics: ${s.topics}`,
        `  Description: ${s.talk_description}`,
        `  Video: ${video}`,
      ].join("\n");
    }),
  ].join("\n");
};

const submittedResult = (result: SubmitResult, ui: boolean) => {
  const summary = `CFP submitted. Submission id: ${result.submission_id}, submitted at ${result.submitted_at}.`;
  if (!("record_url" in result)) {
    return { ...text(`${summary} Video: ${result.video_url}`), structuredContent: { status: "submitted", ...result } };
  }
  return {
    ...text(
      [
        summary,
        "",
        ui
          ? `The submission still needs its 2-minute video. Ask the presenter to record it in the recorder shown with this result. If the camera is blocked, give them this link to record it in their browser instead: ${result.record_url}`
          : `The submission still needs its 2-minute video. Give the presenter this link to record it in their browser: ${result.record_url}`,
      ].join("\n"),
    ),
    structuredContent: { status: "submitted", ...result },
  };
};

function createServer(origin: string, email: string, ui: boolean) {
  const server = new McpServer({ name: "cascadiajs-cfp", version: "1.0.0" }, { instructions: instructions(ui) });

  server.registerTool(
    "create-profile",
    {
      title: "Start a CascadiaJS 2027 CFP submission",
      description: ui
        ? "Start here when the user wants to submit or propose a talk to the CascadiaJS 2027 Call for Presenters (CFP). Saves the signed-in user's presenter profile, which is required before submit-cfp. Call it right away, with no arguments or only details the user has already given you; do not ask for details in chat first. It shows a profile form, pre-filled with anything saved before and anything you pass, for the user to complete. If the profile is already complete, it says so. Every field is optional here."
        : "Start here when the user wants to submit or propose a talk to the CascadiaJS 2027 Call for Presenters (CFP). Saves the signed-in user's presenter profile, which is required before submit-cfp. Call it right away, with no arguments or only details the user has already given you; anything saved before is kept. If the profile is already complete, it says so. Every field is optional here. If details are missing, the result lists them: ask the user for them and call create-profile again with all of them.",
      inputSchema: partialProfileShape,
      ...(ui ? { _meta: { ui: { resourceUri: PROFILE_URI } } } : {}),
    },
    async (input) => {
      try {
        const profile = await profileForEmail(email);
        const merged = { ...savedProfile(profile), ...input };
        const parsed = profileSchema.safeParse(merged);
        if (!parsed.success) {
          if (ui) {
            return {
              ...text(FORM_SHOWN("profile form", "When they save it, you'll be told, and can then call submit-cfp.")),
              structuredContent: { status: "needs_details", email_address: profile.email_address, prefill: merged },
            };
          }
          const missing = missingFields(parsed.error.issues);
          return {
            ...text(
              [
                `Profile not complete yet for ${profile.email_address}: missing or invalid ${describeMissing(missing)}.`,
                "Ask the presenter for these details and call create-profile again with every field.",
              ].join("\n"),
            ),
            structuredContent: { status: "needs_details", email_address: profile.email_address, missing, prefill: merged },
          };
        }
        if (Object.keys(input).length === 0 && profile.profile_completed_at) {
          return {
            ...text(`The profile for ${profile.email_address} is already complete. Next, call submit-cfp to submit a talk.`),
            structuredContent: { status: "profile_complete", email_address: profile.email_address },
          };
        }
        await saveProfile(email, parsed.data);
        return profileSaved(profile.email_address);
      } catch (error) {
        return failure("create-profile", error);
      }
    },
  );

  server.registerTool(
    "submit-cfp",
    {
      title: "Submit a talk to the CascadiaJS 2027 CFP",
      description: ui
        ? "Submit a talk proposal to the CascadiaJS 2027 Call for Presenters for the signed-in user. Requires a completed profile; if create-profile hasn't been run yet, call it first. Call it right away with any talk details you already have; do not collect them in chat first. Every talk field is optional here: the tool shows a form, pre-filled with what you pass, for the user to complete, and then a recorder for their 2-minute video. Pass video_submission_url only if the user already has a public link to their video. Call once per talk."
        : "Submit a talk proposal to the CascadiaJS 2027 Call for Presenters for the signed-in user. Requires a completed profile; if create-profile hasn't been run yet, call it first. Needs the talk title, a description under 280 characters and topics; if any are missing, the result lists them: collect them and call submit-cfp again with all of them. Pass video_submission_url only if the user already has a public link to their video; otherwise the result gives a link where they record it in their browser. Call once per talk.",
      inputSchema: partialSubmissionShape,
      ...(ui ? { _meta: { ui: { resourceUri: SUBMISSION_URI } } } : {}),
    },
    async (input) => {
      try {
        // Check the profile first so an incomplete one fails before the form appears.
        await completedProfile(email);
        const parsed = submissionSchema.safeParse(input);
        if (!parsed.success) {
          if (ui) {
            return {
              ...text(FORM_SHOWN("talk submission form", "The same form then records their 2-minute video, and you'll be told when the talk is submitted.")),
              structuredContent: { status: "needs_details", prefill: input },
            };
          }
          const missing = missingFields(parsed.error.issues);
          return {
            ...text(
              [
                `Not submitted yet: missing or invalid ${describeMissing(missing)}.`,
                "Help the presenter write these details and call submit-cfp again with all of them.",
              ].join("\n"),
            ),
            structuredContent: { status: "needs_details", missing, prefill: input },
          };
        }
        return submittedResult(await submitCfp(email, parsed.data, origin), ui);
      } catch (error) {
        return failure("submit-cfp", error);
      }
    },
  );

  server.registerTool(
    "list-submissions",
    {
      title: "List my CascadiaJS 2027 CFP submissions",
      description:
        "List the talk proposals the signed-in user has submitted to the CascadiaJS 2027 Call for Presenters, newest first, with each talk's details, its review status (under review, accepted, rejected or waitlist) and whether its 2-minute video is attached. Use it when the user asks what they've submitted, and before submitting a talk that might already be there.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const submissions = await listSubmissions(email);
        return { ...text(describeSubmissions(submissions)), structuredContent: { submissions } };
      } catch (error) {
        return failure("list-submissions", error);
      }
    },
  );

  if (ui) registerApps(server, origin, email);
  return server;
}

/** The UI resources and the app-only tools they call, for agents that support MCP Apps. */
function registerApps(server: McpServer, origin: string, email: string) {
  // Called by the profile form, not the model.
  server.registerTool(
    "save-profile",
    {
      description: "Used by the create-profile profile form: saves the signed-in user's complete presenter profile.",
      inputSchema: profileShape,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (input) => {
      try {
        const { email_address } = await saveProfile(email, input);
        return profileSaved(email_address);
      } catch (error) {
        return failure("save-profile", error);
      }
    },
  );

  // Called by the submission form and the recorder, not the model.
  server.registerTool(
    "create-submission",
    {
      description: "Used by the submit-cfp form: saves the talk with every required detail.",
      inputSchema: submissionShape,
      _meta: { ui: { visibility: ["app"] } },
    },
    async (input) => {
      try {
        return submittedResult(await submitCfp(email, input, origin), true);
      } catch (error) {
        return failure("create-submission", error);
      }
    },
  );

  server.registerTool(
    "create-video-upload",
    {
      description: "Used by the submit-cfp recorder: returns a Mux upload URL for the submission's video.",
      inputSchema: recordingShape,
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ recording_token }) => {
      try {
        const result = await createVideoUpload(recording_token, email);
        return { ...text("Upload URL created."), structuredContent: result };
      } catch (error) {
        return failure("create-video-upload", error);
      }
    },
  );

  server.registerTool(
    "attach-video",
    {
      description: "Used by the submit-cfp recorder: attaches the uploaded video to the submission.",
      inputSchema: recordingShape,
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ recording_token }) => {
      try {
        const result = await attachVideo(recording_token, email);
        return { ...text(`Video attached: ${result.video_url}`), structuredContent: result };
      } catch (error) {
        return failure("attach-video", error);
      }
    },
  );

  server.registerResource(
    "profile",
    PROFILE_URI,
    { title: "CFP profile form", mimeType: MCP_APP_MIME_TYPE },
    async () => ({
      contents: [
        { uri: PROFILE_URI, mimeType: MCP_APP_MIME_TYPE, text: PROFILE_APP_HTML, _meta: appResourceMeta() },
      ],
    }),
  );

  server.registerResource(
    "submission",
    SUBMISSION_URI,
    { title: "CFP talk submission form and video recorder", mimeType: MCP_APP_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: SUBMISSION_URI,
          mimeType: MCP_APP_MIME_TYPE,
          text: SUBMISSION_APP_HTML,
          _meta: appResourceMeta({
            permissions: { camera: {}, microphone: {} },
            // Mux direct-upload URLs.
            connectDomains: ["https://*.mux.com", "https://storage.googleapis.com"],
          }),
        },
      ],
    }),
  );
}

// Browser-based MCP clients (such as the MCP Inspector) need CORS, including access to
// WWW-Authenticate to discover sign-in.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
};

/** The 401 that tells agents where to sign in (RFC 9728 resource_metadata). */
function unauthorized(config: AuthConfig, error?: { code: string; description: string }) {
  const challenge = [`Bearer resource_metadata="${config.resourceMetadataUrl}"`];
  if (error) challenge.push(`error="${error.code}"`, `error_description="${error.description}"`);
  return Response.json(
    { error: error?.code ?? "unauthorized", error_description: error?.description ?? "Sign-in required." },
    { status: 401, headers: { ...CORS, "WWW-Authenticate": challenge.join(", ") } },
  );
}

async function signedInEmail(request: Request, config: AuthConfig) {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return { response: unauthorized(config), reason: "no token" };
  try {
    return { email: (await verifyAccessToken(token, config)).email };
  } catch (error) {
    return {
      response: unauthorized(config, { code: "invalid_token", description: "The access token is invalid or expired." }),
      reason: `token rejected: ${error instanceof Error ? error.message : error}; issuer ${tokenIssuer(token)}`,
    };
  }
}

/** The unverified issuer of a JWT, for dev logs only. */
function tokenIssuer(token: string) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).iss ?? "(none)";
  } catch {
    return "(not a JWT)";
  }
}

type Message = { method?: string; params?: any };

/**
 * Whether the agent supports MCP Apps. It says so only in initialize, and this server is
 * stateless, so the answer rides in the session id the server returns from initialize:
 * agents send that id back on every later request, and the transport doesn't check it.
 * An agent that sends no id gets the text-only server, which works everywhere.
 */
function uiSession(request: Request, messages: Message[]) {
  const initialize = messages.find((message) => message?.method === "initialize");
  if (!initialize) return { ui: request.headers.get("mcp-session-id")?.startsWith("ui.") ?? false };
  const mimeTypes = initialize.params?.capabilities?.extensions?.[UI_EXTENSION]?.mimeTypes;
  const ui = Array.isArray(mimeTypes) && mimeTypes.includes(MCP_APP_MIME_TYPE);
  return { ui, sessionId: `${ui ? "ui" : "text"}.${crypto.randomUUID()}` };
}

// Local development only: one line per MCP message, to see what a connected agent does.
function logRequest(messages: Message[], who: string) {
  for (const message of messages) {
    if (!message?.method) continue;
    const params = message.params ?? {};
    const detail =
      message.method === "initialize"
        ? `client=${params.clientInfo?.name}/${params.clientInfo?.version} protocol=${params.protocolVersion} mcpApps=${JSON.stringify(params.capabilities?.extensions?.[UI_EXTENSION] ?? null)}`
        : message.method === "tools/call"
          ? `tool=${params.name} args=${Object.keys(params.arguments ?? {}).join(",")}`
          : message.method === "resources/read"
            ? `uri=${params.uri}`
            : "";
    console.log(`[mcp] ${who} ${message.method} ${detail}`);
  }
}

export default async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  const origin = new URL(request.url).origin;
  let config: AuthConfig;
  try {
    config = authConfig(origin);
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Sign-in isn't configured on this server." }, { status: 500, headers: CORS });
  }
  const signedIn = await signedInEmail(request, config);
  const body = await request.clone().json().catch(() => null);
  const messages: Message[] = Array.isArray(body) ? body : [body];
  if (process.env.NETLIFY_DEV === "true") logRequest(messages, signedIn.email ?? `(not signed in: ${signedIn.reason})`);
  if (!signedIn.email) return signedIn.response;

  const { ui, sessionId } = uiSession(request, messages);
  const server = createServer(origin, signedIn.email, ui);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  const response = await transport.handleRequest(request);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS)) headers.set(name, value);
  if (sessionId && response.ok) headers.set("Mcp-Session-Id", sessionId);
  return new Response(response.body, { status: response.status, headers });
};

export const config: Config = { path: "/mcp" };
