import type { Config } from "@netlify/functions";
import { websiteSignInConfigured } from "../lib/auth/config.js";
import { sessionEmail } from "../lib/auth/session.js";
import { listSubmissions, profileForEmail, savedProfile } from "../lib/cfp.js";
import { signedInPage, signedOutPage } from "../lib/submit-page.js";

// /submit: submit a talk on the website instead of through an agent (lib/submit-page.ts).
// Signed out, it offers sign-in (/auth/login); signed in, it shows the forms.

export default async (request: Request) => {
  const configured = Boolean(websiteSignInConfigured());
  const email = configured ? await sessionEmail(request) : undefined;
  if (!email) return signedOutPage({ configured, error: new URL(request.url).searchParams.get("error") });

  const profile = await profileForEmail(email);
  return signedInPage({
    email: profile.email_address,
    profile: savedProfile(profile),
    profile_complete: Boolean(profile.profile_completed_at),
    submissions: await listSubmissions(email),
  });
};

export const config: Config = { path: "/submit", method: "GET" };
