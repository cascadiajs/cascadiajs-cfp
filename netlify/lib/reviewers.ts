import { getDatabase } from "@netlify/database";
import { z } from "zod";
import { emailConfigured, sendEmail } from "./email.js";
import { CfpError } from "./errors.js";
import { escapeHtml } from "./page.js";

// The /review allow-list (table public.reviewers). Admins invite reviewers by email and can
// remove them; both read submissions. Access is looked up on every request, so removing
// someone takes effect on their next page load even though their session cookie lives on.

export type ReviewerRole = "admin" | "reviewer";

type ReviewerRow = { email: string; name: string; role: ReviewerRole; accepted: string | Date | null };

const toReviewer = (row: ReviewerRow) => ({
  email: row.email,
  name: row.name,
  role: row.role,
  accepted: row.accepted ? new Date(row.accepted).toISOString() : null,
});

export type Reviewer = ReturnType<typeof toReviewer>;

const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * The reviewer a signed-in email belongs to, or undefined if it isn't on the list. Signing
 * in is how an invitation is accepted, so the first call for a pending one sets accepted.
 */
export async function reviewerForEmail(email: string) {
  // The outer SELECT sees the table as it was before the UPDATE, so exactly one branch
  // returns the row, and rows already accepted aren't rewritten on every request.
  const rows = (await getDatabase().sql`
    WITH accepting AS (
      UPDATE public.reviewers SET accepted = now()
      WHERE email = ${normalizeEmail(email)} AND accepted IS NULL
      RETURNING *
    )
    SELECT * FROM accepting
    UNION ALL
    SELECT * FROM public.reviewers WHERE email = ${normalizeEmail(email)} AND accepted IS NOT NULL
  `) as ReviewerRow[];
  return rows[0] ? toReviewer(rows[0]) : undefined;
}

/** Everyone on the list: admins first, then pending invitations, then by name. */
export async function listReviewers() {
  const rows = (await getDatabase().sql`
    SELECT * FROM public.reviewers
    ORDER BY role = 'admin' DESC, accepted IS NULL DESC, lower(name), email
  `) as ReviewerRow[];
  return rows.map(toReviewer);
}

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  name: z.string().trim().min(1, "Enter their name"),
});

/**
 * Adds a reviewer and emails them a link to /review. If the email can't be sent, the
 * invitation is taken back so the admin can simply try again. Without Resend set up
 * (local development), the invitation is kept and emailed is false.
 */
export async function inviteReviewer(input: z.infer<typeof inviteSchema>, invitedBy: Reviewer, origin: string) {
  const db = getDatabase();
  const added = (await db.sql`
    INSERT INTO public.reviewers (email, name, role) VALUES (${input.email}, ${input.name}, 'reviewer')
    ON CONFLICT (email) DO NOTHING
    RETURNING email
  `) as { email: string }[];
  if (!added.length) throw new CfpError(409, `${input.email} is already on the reviewer list.`);

  if (!emailConfigured()) {
    console.warn(`RESEND_API_KEY is not set: no invitation email sent to ${input.email}`);
    return { emailed: false };
  }
  try {
    await sendEmail(invitationEmail(input, invitedBy, `${origin}/review`));
  } catch (error) {
    console.error(`Invitation email to ${input.email} failed`, error);
    await db.sql`DELETE FROM public.reviewers WHERE email = ${input.email} AND accepted IS NULL`;
    throw new CfpError(502, `The invitation email to ${input.email} couldn't be sent, so they weren't added. Please try again.`);
  }
  return { emailed: true };
}

/** Takes someone off the list, which ends their access to /review. */
export async function removeReviewer(email: string, removedBy: Reviewer) {
  const target = normalizeEmail(email);
  if (target === removedBy.email) throw new CfpError(400, "You can't remove yourself.");
  const removed = (await getDatabase().sql`
    DELETE FROM public.reviewers WHERE email = ${target} RETURNING email
  `) as { email: string }[];
  // 409 rather than 404: the page is shown again with this message, and Netlify Dev replaces 404 pages.
  if (!removed.length) throw new CfpError(409, `${target} isn't on the reviewer list.`);
}

function invitationEmail(invitee: { email: string; name: string }, invitedBy: Reviewer, reviewUrl: string) {
  const intro = `${invitedBy.name} invited you to review talk submissions for the CascadiaJS 2027 Call for Presenters.`;
  const signIn = `Sign in with this email address (${invitee.email}). We'll email you a one-time code; there's no password.`;
  return {
    to: invitee.email,
    subject: "You're invited to review CascadiaJS 2027 talks",
    text: `Hi ${invitee.name},\n\n${intro}\n\nOpen ${reviewUrl} to see the submissions. ${signIn}\n\nThanks for helping out!\nCascadiaJS`,
    html: `<p>Hi ${escapeHtml(invitee.name)},</p>
<p>${escapeHtml(intro)}</p>
<p><a href="${escapeHtml(reviewUrl)}">Open the review page</a> to see the submissions. ${escapeHtml(signIn)}</p>
<p>Thanks for helping out!<br>CascadiaJS</p>`,
  };
}
