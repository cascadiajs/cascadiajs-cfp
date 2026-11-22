import type { Config } from "@netlify/functions";
import { websiteSignInConfigured } from "../lib/auth/config.js";
import { sameOrigin, sessionEmail } from "../lib/auth/session.js";
import { allSubmissions, CfpError } from "../lib/cfp.js";
import { inviteReviewer, inviteSchema, listReviewers, removeReviewer, reviewerForEmail, type Reviewer } from "../lib/reviewers.js";
import { notAuthorizedPage, reviewPage, signedOutPage, unavailablePage, type AdminState } from "../lib/review-page.js";

// /review: CFP submissions for the reviewers in public.reviewers, who sign in like
// presenters do on /submit (Auth0 website application, session cookie). Admins also manage
// the reviewer list. Everyone else who signs in is told they're not authorized.
//
//   GET  /review         the page
//   POST /review/invite  admins: add a reviewer and email them an invitation (form: name, email)
//   POST /review/remove  admins: take someone off the list, ending their access (form: email)

function redirect(location: string) {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}

type Message = { kind: "success" | "error" | ""; text: string };

async function showPage(me: Reviewer, options: { status?: number; message?: Message; invite?: AdminState["invite"] } = {}) {
  const [submissions, reviewers] = await Promise.all([allSubmissions(), me.role === "admin" ? listReviewers() : undefined]);
  return reviewPage({
    status: options.status,
    me,
    submissions,
    admin: reviewers ? { reviewers, invite: options.invite } : undefined,
    message: options.message,
  });
}

/**
 * The outcome of the last invite or removal, from the query string it redirected to. Only
 * shown when the list agrees, so a crafted link can't make the page claim something false.
 */
async function outcome(url: URL, me: Reviewer): Promise<Message | undefined> {
  if (me.role !== "admin") return undefined;
  const invited = url.searchParams.get("invited");
  const removed = url.searchParams.get("removed");
  if (!invited && !removed) return undefined;
  const emails = new Set((await listReviewers()).map((person) => person.email));
  if (invited && emails.has(invited)) {
    return url.searchParams.get("emailed") === "0"
      ? { kind: "", text: `${invited} was added, but no email was sent because email isn't set up (RESEND_API_KEY). Send them the link to this page yourself.` }
      : { kind: "success", text: `Invitation sent to ${invited}.` };
  }
  if (removed && !emails.has(removed)) return { kind: "success", text: `${removed} was removed and can no longer open this page.` };
  return undefined;
}

async function admin(request: Request) {
  if (!sameOrigin(request)) throw new CfpError(403, "Cross-site requests aren't allowed.");
  const email = await sessionEmail(request);
  const me = email ? await reviewerForEmail(email) : undefined;
  if (!me || me.role !== "admin") throw new CfpError(403, "Only admins can change the reviewer list.");
  return me;
}

async function form(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    throw new CfpError(415, "Send the form as application/x-www-form-urlencoded.");
  }
  return new URLSearchParams(await request.text());
}

async function invite(request: Request, url: URL) {
  const me = await admin(request);
  const fields = await form(request);
  const entered = { name: fields.get("name") ?? "", email: fields.get("email") ?? "" };
  const parsed = inviteSchema.safeParse(entered);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(". ");
    return showPage(me, { status: 400, message: { kind: "error", text: `${message}.` }, invite: entered });
  }
  try {
    const { emailed } = await inviteReviewer(parsed.data, me, url.origin);
    return redirect(`/review?${new URLSearchParams({ invited: parsed.data.email, ...(emailed ? {} : { emailed: "0" }) })}`);
  } catch (error) {
    if (!(error instanceof CfpError)) throw error;
    return showPage(me, { status: error.status, message: { kind: "error", text: error.message }, invite: entered });
  }
}

async function remove(request: Request) {
  const me = await admin(request);
  const email = (await form(request)).get("email") ?? "";
  try {
    await removeReviewer(email, me);
    return redirect(`/review?${new URLSearchParams({ removed: email.trim().toLowerCase() })}`);
  } catch (error) {
    if (!(error instanceof CfpError)) throw error;
    return showPage(me, { status: error.status, message: { kind: "error", text: error.message } });
  }
}

async function view(request: Request, url: URL) {
  if (!websiteSignInConfigured()) return unavailablePage();
  const email = await sessionEmail(request);
  if (!email) return signedOutPage(url.searchParams.get("error"));
  const me = await reviewerForEmail(email);
  if (!me) return notAuthorizedPage(email);
  return showPage(me, { message: await outcome(url, me) });
}

export default async (request: Request) => {
  const url = new URL(request.url);
  const endpoint = `${request.method} ${url.pathname.replace(/\/+$/, "")}`;
  try {
    switch (endpoint) {
      case "GET /review":
        return await view(request, url);
      case "POST /review/invite":
        return await invite(request, url);
      case "POST /review/remove":
        return await remove(request);
      default:
        return new Response("Not found", { status: 404 });
    }
  } catch (error) {
    if (error instanceof CfpError) return new Response(error.message, { status: error.status, headers: { "Cache-Control": "no-store" } });
    console.error(`${endpoint} failed`, error);
    return new Response("Something went wrong. Please try again later.", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
};

export const config: Config = { path: ["/review", "/review/invite", "/review/remove"] };
