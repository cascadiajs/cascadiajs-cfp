import type { Config } from "@netlify/functions";
import { authConfig } from "../lib/auth/config.js";

// Protected resource metadata (RFC 9728) for the MCP server. Agents fetch it after /mcp
// answers 401, and it sends them to the Auth0 tenant to sign the presenter in.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, MCP-Protocol-Version",
};

export default async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const origin = new URL(request.url).origin;
  let config: ReturnType<typeof authConfig>;
  try {
    config = authConfig(origin);
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Sign-in isn't configured on this server." }, { status: 500, headers: CORS });
  }
  return Response.json(
    {
      resource: config.resource,
      authorization_servers: [config.issuer],
      // Agents request these: the OIDC scopes Auth0's MCP samples list, plus offline_access
      // so agents get refresh tokens (the Auth0 API must allow offline access).
      scopes_supported: ["openid", "profile", "email", "offline_access"],
      bearer_methods_supported: ["header"],
      resource_name: "CascadiaJS 2027 CFP",
      resource_documentation: `${origin}/`,
    },
    { headers: { ...CORS, "Cache-Control": "public, max-age=300" } },
  );
};

export const config: Config = {
  path: ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
  method: ["GET", "OPTIONS"],
};
