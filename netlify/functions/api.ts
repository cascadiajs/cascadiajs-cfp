import type { Config } from "@netlify/functions";
import type { z } from "zod";
import { withAnalytics } from "../lib/analytics.js";
import { sameOrigin, sessionEmail } from "../lib/auth/session.js";
import {
  attachVideo,
  CfpError,
  createVideoUpload,
  listSubmissions,
  profileForEmail,
  profileSchema,
  saveProfile,
  submissionSchema,
  submitCfp,
} from "../lib/cfp.js";

// REST endpoints for the site's pages. Each one does what the MCP tool of the same purpose
// does (mcp.ts), with the same schemas and CFP functions (cfp.ts) and the same result, so
// the shared form components (see SITE_API_SCRIPT in lib/app.ts) work the same on both.
//
// Signed in on the website (session cookie from /auth/callback), for /submit:
//   POST /api/profile              save-profile: save the complete profile
//   POST /api/submissions          create-submission: submit a talk
//   GET  /api/submissions          list-submissions: the presenter's talks, newest first
//
// With a recording token, a single-purpose token returned when a talk is submitted without
// a video link, for the recorder on /submit and /record:
//   POST /api/recordings/upload    create-video-upload: get a Mux upload URL (Authorization: Bearer <recording token>)
//   POST /api/recordings/complete  attach-video: attach the uploaded video (Authorization: Bearer <recording token>)

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function recordingToken(request: Request) {
  const match = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i);
  if (!match) throw new CfpError(401, "Missing recording token. Send it as Authorization: Bearer <recording token>.");
  return match[1];
}

async function signedIn(request: Request) {
  if (!sameOrigin(request)) throw new CfpError(403, "Cross-site requests aren't allowed.");
  const email = await sessionEmail(request);
  if (!email) throw new CfpError(401, "You're signed out. Reload the page to sign in again.");
  return email;
}

/** Parses a JSON request body with a CFP schema, naming the fields that fail. */
async function parseBody<T extends z.ZodTypeAny>(request: Request, schema: T): Promise<z.infer<T>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new CfpError(415, "Send the details as JSON.");
  }
  const parsed = schema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "details").replaceAll("_", " ")))];
    throw new CfpError(400, `Check these details and try again: ${fields.join(", ")}.`);
  }
  return parsed.data;
}

/** CFP events sent by fn say they came from the website, like MCP ones say "mcp". */
const fromWebsite = <T>(fn: () => Promise<T>) => withAnalytics({ channel: "web" }, fn);

async function route(request: Request, url: URL): Promise<Response> {
  const endpoint = `${request.method} ${url.pathname.replace(/\/+$/, "")}`;

  switch (endpoint) {
    case "POST /api/profile": {
      const email = await signedIn(request);
      const result = await fromWebsite(async () => saveProfile(email, await parseBody(request, profileSchema)));
      return json(200, { status: "profile_complete", ...result });
    }

    case "POST /api/submissions": {
      const email = await signedIn(request);
      const talk = await parseBody(request, submissionSchema);
      // submitCfp checks this too, but its message is for agents (it names create-profile).
      if (!(await profileForEmail(email)).profile_completed_at) {
        throw new CfpError(400, "Save your profile before submitting a talk.");
      }
      return json(200, { status: "submitted", ...(await fromWebsite(() => submitCfp(email, talk, url.origin))) });
    }

    case "GET /api/submissions": {
      const email = await signedIn(request);
      return json(200, { submissions: await listSubmissions(email) });
    }

    case "POST /api/recordings/upload":
      return json(200, await createVideoUpload(recordingToken(request)));

    case "POST /api/recordings/complete":
      return json(200, await attachVideo(recordingToken(request)));

    default:
      return json(404, { error: "Not found" });
  }
}

export default async (request: Request) => {
  try {
    return await route(request, new URL(request.url));
  } catch (error) {
    if (error instanceof CfpError) return json(error.status, { error: error.message });
    console.error("API request failed", error);
    return json(500, { error: "Something went wrong. Please try again later." });
  }
};

export const config: Config = { path: "/api/*" };
