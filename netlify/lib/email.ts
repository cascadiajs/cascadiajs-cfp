// Email through Resend (https://resend.com/docs/api-reference/emails/send-email). Only
// /review sends email, to invite reviewers. Off unless RESEND_API_KEY is set; RESEND_FROM
// must be an address on a domain verified in Resend.

const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "CascadiaJS <cfp@cascadiajs.com>";

export const emailConfigured = () => Boolean(process.env.RESEND_API_KEY?.trim());

export async function sendEmail(message: { to: string; subject: string; text: string; html: string }) {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) throw new Error("RESEND_API_KEY is not set");
  const response = await fetch(RESEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.RESEND_FROM?.trim() || DEFAULT_FROM, ...message, to: [message.to] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`Resend answered ${response.status}: ${(await response.text().catch(() => "")).slice(0, 500)}`);
  }
}
