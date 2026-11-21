import { createRemoteJWKSet, jwtVerify } from "jose";
import { type AuthConfig, EMAIL_CLAIM, type WebsiteAuthConfig } from "./config.js";

// Checks Auth0 access tokens (agents) and ID tokens (the website): JWTs signed with the
// tenant's published keys. jose caches the key set and refetches it when Auth0 rotates keys.

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

/**
 * Verifies the ID token the website gets when a presenter signs in, and returns their
 * verified email. Same signature rules as access tokens, but for the website application
 * (audience) and this sign-in (nonce).
 */
export async function verifyIdToken(token: string, config: WebsiteAuthConfig, nonce: string) {
  const { payload } = await jwtVerify(token, keySet(config.jwksUri), {
    issuer: config.issuer,
    audience: config.clientId,
    algorithms: ["RS256"],
    requiredClaims: ["iat", "exp", "sub"],
  });
  if (payload.nonce !== nonce) throw new Error("ID token nonce doesn't match the sign-in");
  const email = payload.email;
  if (typeof email !== "string" || !email.includes("@") || payload.email_verified !== true) {
    throw new Error("ID token has no verified email");
  }
  return { email };
}
