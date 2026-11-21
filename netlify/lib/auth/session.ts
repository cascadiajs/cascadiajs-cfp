import { jwtVerify, SignJWT } from "jose";

// Website sessions. After a presenter signs in with Auth0 (netlify/functions/auth.ts), the
// site keeps their verified email in a signed, HttpOnly cookie, so the page's own requests
// (netlify/functions/api.ts) act for them the way an access token does for an agent.
// A second short-lived cookie carries the sign-in's state, nonce and PKCE verifier from
// /auth/login to /auth/callback.

const SESSION_COOKIE = "cfp_session";
const SESSION_DAYS = 7;
const SIGN_IN_COOKIE = "cfp_sign_in";
const SIGN_IN_MINUTES = 10;

function secretKey() {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return new TextEncoder().encode(secret);
}

// Each cookie's JWT has its own audience, so one can't stand in for the other.
const sign = (payload: Record<string, string>, audience: string, expires: string) =>
  new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setAudience(audience).setIssuedAt().setExpirationTime(expires).sign(secretKey());

async function verify(token: string, audience: string) {
  const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"], audience });
  return payload;
}

function readCookie(request: Request, name: string) {
  for (const part of request.headers.get("cookie")?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function cookie(request: Request, name: string, value: string, options: { path: string; maxAge: number }) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=${options.path}; Max-Age=${options.maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

/** The signed-in presenter's email, or undefined. */
export async function sessionEmail(request: Request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return undefined;
  try {
    const { email } = await verify(token, "cfp-session");
    return typeof email === "string" ? email : undefined;
  } catch {
    return undefined;
  }
}

export async function sessionCookie(request: Request, email: string) {
  const token = await sign({ email }, "cfp-session", `${SESSION_DAYS}d`);
  return cookie(request, SESSION_COOKIE, token, { path: "/", maxAge: SESSION_DAYS * 86400 });
}

export const clearSessionCookie = (request: Request) => cookie(request, SESSION_COOKIE, "", { path: "/", maxAge: 0 });

export type SignIn = { state: string; nonce: string; verifier: string };

export async function signInCookie(request: Request, signIn: SignIn) {
  const token = await sign(signIn, "cfp-sign-in", `${SIGN_IN_MINUTES}m`);
  return cookie(request, SIGN_IN_COOKIE, token, { path: "/auth/callback", maxAge: SIGN_IN_MINUTES * 60 });
}

/** The sign-in started by /auth/login in this browser, or undefined if it's missing or expired. */
export async function pendingSignIn(request: Request): Promise<SignIn | undefined> {
  const token = readCookie(request, SIGN_IN_COOKIE);
  if (!token) return undefined;
  try {
    const { state, nonce, verifier } = await verify(token, "cfp-sign-in");
    if (typeof state !== "string" || typeof nonce !== "string" || typeof verifier !== "string") return undefined;
    return { state, nonce, verifier };
  } catch {
    return undefined;
  }
}

export const clearSignInCookie = (request: Request) =>
  cookie(request, SIGN_IN_COOKIE, "", { path: "/auth/callback", maxAge: 0 });

/**
 * Rejects cross-site requests that would act on a session: the session cookie is
 * SameSite=Lax, and this also checks the Origin header that browsers send with POSTs.
 */
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
