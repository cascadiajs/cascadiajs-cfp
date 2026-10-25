import { createRemoteJWKSet, jwtVerify } from "jose";
import { type AuthConfig, EMAIL_CLAIM } from "./config.js";

// Checks Auth0 access tokens: JWTs signed with the tenant's published keys. jose caches
// the key set and refetches it when Auth0 rotates keys.

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySet(uri: string) {
  let set = keySets.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri));
    keySets.set(uri, set);
  }
  return set;
}

/**
 * Verifies the token's signature, issuer, audience and expiry, and returns the presenter's
 * email. The algorithm and required claims match Auth0's own verifier (@auth0/auth0-api-js),
 * plus the subject and client the Auth0 MCP samples require.
 */
export async function verifyAccessToken(token: string, config: AuthConfig) {
  const { payload } = await jwtVerify(token, keySet(config.jwksUri), {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: ["RS256"],
    requiredClaims: ["iat", "exp", "sub"],
  });
  if (typeof payload.azp !== "string" && typeof payload.client_id !== "string") {
    throw new Error("Access token has no client (azp or client_id claim)");
  }
  const email = payload[EMAIL_CLAIM];
  if (typeof email !== "string" || !email.includes("@")) throw new Error(`Access token has no ${EMAIL_CLAIM} claim`);
  return { email };
}
