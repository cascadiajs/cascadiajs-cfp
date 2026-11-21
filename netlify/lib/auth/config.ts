// Sign-in is handled by Auth0, in two ways (see "Sign-in with Auth0" in SETUP.md):
//
// - Agents: the MCP server is an OAuth protected resource. It tells agents to sign in with
//   the Auth0 tenant (protected resource metadata) and checks the access tokens Auth0
//   issues for this server's API (authConfig).
// - The website: /submit signs presenters in with the tenant's "website" application
//   (authorization code flow) and keeps them signed in with a session cookie
//   (websiteAuthConfig, session.ts).

/** Access-token claim holding the presenter's verified email, added by the Auth0 post-login Action. */
export const EMAIL_CLAIM = "https://cfp.cascadiajs.com/email";

/** The Auth0 tenant's base URL, from AUTH0_DOMAIN. */
function auth0Base() {
  const domain = process.env.AUTH0_DOMAIN?.trim();
  if (!domain) throw new Error("AUTH0_DOMAIN is not set (for example cascadiajs.us.auth0.com)");
  // A bare domain is the usual setting; a full base URL is accepted too (for a custom domain or testing).
  return /^https?:\/\//.test(domain) ? domain.replace(/\/+$/, "") : `https://${domain}`;
}

export function authConfig(origin: string) {
  const base = auth0Base();
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

const WEBSITE_VARIABLES = ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "SESSION_SECRET"] as const;

/** Whether every variable website sign-in needs is set. */
export const websiteSignInConfigured = () => WEBSITE_VARIABLES.every((name) => process.env[name]?.trim());

/** Website sign-in: the Auth0 "website" application (a Regular Web Application). */
export function websiteAuthConfig(origin: string) {
  const missing = WEBSITE_VARIABLES.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Website sign-in needs ${missing.join(", ")}`);
  const base = auth0Base();
  return {
    issuer: `${base}/`,
    jwksUri: `${base}/.well-known/jwks.json`,
    authorizeUrl: `${base}/authorize`,
    tokenUrl: `${base}/oauth/token`,
    logoutUrl: `${base}/v2/logout`,
    clientId: process.env.AUTH0_CLIENT_ID!.trim(),
    clientSecret: process.env.AUTH0_CLIENT_SECRET!.trim(),
    /** Must be in the application's Allowed Callback URLs. */
    callbackUrl: `${origin}/auth/callback`,
    /** Must be in the application's Allowed Logout URLs. */
    signedOutUrl: `${origin}/submit`,
  };
}

export type WebsiteAuthConfig = ReturnType<typeof websiteAuthConfig>;
