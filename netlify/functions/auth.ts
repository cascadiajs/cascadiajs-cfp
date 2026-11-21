import { createHash, randomBytes } from "node:crypto";
import type { Config } from "@netlify/functions";
import { track, withAnalytics } from "../lib/analytics.js";
import { websiteAuthConfig } from "../lib/auth/config.js";
import {
  clearSessionCookie,
  clearSignInCookie,
  pendingSignIn,
  sameOrigin,
  sessionCookie,
  signInCookie,
} from "../lib/auth/session.js";
import { verifyIdToken } from "../lib/auth/tokens.js";
import { profileForEmail } from "../lib/cfp.js";

// Website sign-in for /submit, with the Auth0 "website" application (authorization code
// flow with PKCE). Auth0 shows the same passwordless email sign-in agents get; the site
// then keeps the verified email in a session cookie (lib/auth/session.ts).
//
//   GET  /auth/login     start signing in: redirects to Auth0
//   GET  /auth/callback  where Auth0 sends the presenter back: sets the session cookie
//   POST /auth/logout    sign out of the site and of Auth0

const random = () => randomBytes(32).toString("base64url");

function redirect(location: string, cookies: string[] = [], status = 302) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status, headers });
}

const backToSubmit = (origin: string, error?: string) =>
  `${origin}/submit${error ? `?error=${encodeURIComponent(error)}` : ""}`;

async function login(request: Request, origin: string) {
  const config = websiteAuthConfig(origin);
  const signIn = { state: random(), nonce: random(), verifier: random() };
  const url = new URL(config.authorizeUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: "openid email",
    state: signIn.state,
    nonce: signIn.nonce,
    code_challenge: createHash("sha256").update(signIn.verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return redirect(url.toString(), [await signInCookie(request, signIn)]);
}

async function callback(request: Request, url: URL) {
  const config = websiteAuthConfig(url.origin);
  const signIn = await pendingSignIn(request);
  const clear = [clearSignInCookie(request)];
  // The presenter cancelled, or Auth0 refused: logged, and they can try again.
  if (url.searchParams.has("error")) {
    console.warn("Website sign-in failed at Auth0:", url.searchParams.get("error"), url.searchParams.get("error_description"));
    return redirect(backToSubmit(url.origin, "signin"), clear);
  }
  const code = url.searchParams.get("code");
  if (!signIn || !code || url.searchParams.get("state") !== signIn.state) {
    console.warn("Website sign-in callback without a matching sign-in");
    return redirect(backToSubmit(url.origin, "signin"), clear);
  }

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.callbackUrl,
      code_verifier: signIn.verifier,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const tokens = (await response.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!response.ok || !tokens.id_token) {
    console.error("Website sign-in token exchange failed", response.status, tokens.error);
    return redirect(backToSubmit(url.origin, "signin"), clear);
  }
  const { email } = await verifyIdToken(tokens.id_token, config, signIn.nonce);

  const profile = await profileForEmail(email);
  await withAnalytics({ channel: "web" }, () => track("web_signed_in", profile.id));
  return redirect(backToSubmit(url.origin), [...clear, await sessionCookie(request, email)]);
}

function logout(request: Request, origin: string) {
  const config = websiteAuthConfig(origin);
  // Also ends the Auth0 session, so the next sign-in asks for an email again.
  const url = new URL(config.logoutUrl);
  url.search = new URLSearchParams({ client_id: config.clientId, returnTo: config.signedOutUrl }).toString();
  return redirect(url.toString(), [clearSessionCookie(request)], 303);
}

export default async (request: Request) => {
  const url = new URL(request.url);
  const endpoint = `${request.method} ${url.pathname.replace(/\/+$/, "")}`;
  try {
    switch (endpoint) {
      case "GET /auth/login":
        return await login(request, url.origin);
      case "GET /auth/callback":
        return await callback(request, url);
      case "POST /auth/logout":
        if (!sameOrigin(request)) return new Response("Forbidden", { status: 403 });
        return logout(request, url.origin);
      default:
        return new Response("Not found", { status: 404 });
    }
  } catch (error) {
    console.error(`${endpoint} failed`, error);
    // Configuration and sign-in failures both land back on /submit, which explains them.
    return redirect(backToSubmit(url.origin, "signin"), endpoint === "GET /auth/callback" ? [clearSignInCookie(request)] : []);
  }
};

export const config: Config = { path: ["/auth/login", "/auth/callback", "/auth/logout"] };
