import { createHash, randomBytes } from "node:crypto";
import type { Config } from "@netlify/functions";
import { track, withAnalytics } from "../lib/analytics.js";
import { signInPage, websiteAuthConfig, type SignInPage } from "../lib/auth/config.js";
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

// Website sign-in for /submit (presenters) and /review (reviewers), with the Auth0 "website"
// application (authorization code flow with PKCE). Auth0 shows the same passwordless email
// sign-in agents get; the site then keeps the verified email in a session cookie
// (lib/auth/session.ts). ?return=/review comes back to /review instead of /submit.
//
//   GET  /auth/login     start signing in: redirects to Auth0
//   GET  /auth/callback  where Auth0 sends the person back: sets the session cookie
//   POST /auth/logout    sign out of the site and of Auth0

const random = () => randomBytes(32).toString("base64url");

function redirect(location: string, cookies: string[] = [], status = 302) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status, headers });
}

const backTo = (origin: string, page: SignInPage, error?: string) =>
  `${origin}${page}${error ? `?error=${encodeURIComponent(error)}` : ""}`;

async function login(request: Request, url: URL) {
  const config = websiteAuthConfig(url.origin);
  const signIn = { state: random(), nonce: random(), verifier: random(), returnTo: signInPage(url.searchParams.get("return")) };
  const authorize = new URL(config.authorizeUrl);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: "openid email",
    state: signIn.state,
    nonce: signIn.nonce,
    code_challenge: createHash("sha256").update(signIn.verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return redirect(authorize.toString(), [await signInCookie(request, signIn)]);
}

async function callback(request: Request, url: URL) {
  const signIn = await pendingSignIn(request);
  const page = signIn?.returnTo ?? "/submit";
  const clear = [clearSignInCookie(request)];
  try {
    const config = websiteAuthConfig(url.origin);
    // The person cancelled, or Auth0 refused: logged, and they can try again.
    if (url.searchParams.has("error")) {
      console.warn("Website sign-in failed at Auth0:", url.searchParams.get("error"), url.searchParams.get("error_description"));
      return redirect(backTo(url.origin, page, "signin"), clear);
    }
    const code = url.searchParams.get("code");
    if (!signIn || !code || url.searchParams.get("state") !== signIn.state) {
      console.warn("Website sign-in callback without a matching sign-in");
      return redirect(backTo(url.origin, page, "signin"), clear);
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
      return redirect(backTo(url.origin, page, "signin"), clear);
    }
    const { email } = await verifyIdToken(tokens.id_token, config, signIn.nonce);

    // Reviewers aren't presenters: only /submit sign-ins get a presenter profile.
    if (page === "/submit") {
      const profile = await profileForEmail(email);
      await withAnalytics({ channel: "web" }, () => track("web_signed_in", profile.id));
    }
    return redirect(backTo(url.origin, page), [...clear, await sessionCookie(request, email)]);
  } catch (error) {
    console.error("GET /auth/callback failed", error);
    return redirect(backTo(url.origin, page, "signin"), clear);
  }
}

function logout(request: Request, url: URL) {
  const config = websiteAuthConfig(url.origin);
  // Also ends the Auth0 session, so the next sign-in asks for an email again.
  const auth0 = new URL(config.logoutUrl);
  const returnTo = config.signedOutUrl(signInPage(url.searchParams.get("return")));
  auth0.search = new URLSearchParams({ client_id: config.clientId, returnTo }).toString();
  return redirect(auth0.toString(), [clearSessionCookie(request)], 303);
}

export default async (request: Request) => {
  const url = new URL(request.url);
  const endpoint = `${request.method} ${url.pathname.replace(/\/+$/, "")}`;
  try {
    switch (endpoint) {
      case "GET /auth/login":
        return await login(request, url);
      case "GET /auth/callback":
        return await callback(request, url);
      case "POST /auth/logout":
        if (!sameOrigin(request)) return new Response("Forbidden", { status: 403 });
        return logout(request, url);
      default:
        return new Response("Not found", { status: 404 });
    }
  } catch (error) {
    console.error(`${endpoint} failed`, error);
    // Configuration failures land back on the page, which explains them.
    return redirect(backTo(url.origin, signInPage(url.searchParams.get("return")), "signin"));
  }
};

export const config: Config = { path: ["/auth/login", "/auth/callback", "/auth/logout"] };
