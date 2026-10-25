import type { Config } from "@netlify/functions";
import { attachVideo, CfpError, createVideoUpload } from "../lib/cfp.js";

// REST endpoints for the /record fallback page, which records a submission's video when
// the agent can't show the in-chat recorder. Profiles and talks are only created through
// the MCP server (mcp.ts), which requires sign-in. The recording token is a single-purpose
// token returned by submit-cfp for one submission's video.
//
//   POST /api/recordings/upload   get a Mux upload URL (Authorization: Bearer <recording token>)
//   POST /api/recordings/complete attach the uploaded video (Authorization: Bearer <recording token>)

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function recordingToken(request: Request) {
  const match = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i);
  if (!match) throw new CfpError(401, "Missing recording token. Send it as Authorization: Bearer <recording token>.");
  return match[1];
}

async function route(request: Request, url: URL): Promise<Response> {
  const endpoint = `${request.method} ${url.pathname.replace(/\/+$/, "")}`;

  switch (endpoint) {
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
