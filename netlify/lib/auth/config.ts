// Sign-in is handled by Auth0. The MCP server is an OAuth protected resource: it tells
// agents to sign in with the Auth0 tenant (protected resource metadata) and checks the
// access tokens Auth0 issues for this server's API. See "Sign-in with Auth0" in SETUP.md.

/** Access-token claim holding the presenter's verified email, added by the Auth0 post-login Action. */
export const EMAIL_CLAIM = "https://cfp.cascadiajs.com/email";

export function authConfig(origin: string) {
  const domain = process.env.AUTH0_DOMAIN?.trim();
  if (!domain) throw new Error("AUTH0_DOMAIN is not set (for example cascadiajs.us.auth0.com)");
  // A bare domain is the usual setting; a full base URL is accepted too (for a custom domain or testing).
  const base = /^https?:\/\//.test(domain) ? domain.replace(/\/+$/, "") : `https://${domain}`;
  const resource = `${origin}/mcp`;
  return {
    /** The protected resource (RFC 8707 resource indicator). */
    resource,
    resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
    /** Auth0 issuers end with a slash. */
    issuer: `${base}/`,
    jwksUri: `${base}/.well-known/jwks.json`,
    /**
     * The Auth0 API identifier. It must equal the resource: agents send the resource from
     * the protected resource metadata, and Auth0 issues the token for the API with that identifier.
     */
    audience: resource,
  };
}

export type AuthConfig = ReturnType<typeof authConfig>;
