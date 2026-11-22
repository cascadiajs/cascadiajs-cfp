// The /review page (netlify/functions/review.ts): CFP submissions for reviewers, plus the
// reviewer list for admins. Rendered on the server; its forms post to /review/* and come
// back to the page. Its scripts only draw the submissions chart and confirm deletions.

import { APP_STYLES, FORM_STYLES } from "./app.js";
import type { SubmissionResult, SubmissionStatus } from "./cfp.js";
import { escapeHtml, scriptJson, sitePage } from "./page.js";
import type { Reviewer } from "./reviewers.js";

const TITLE = "Review talks";
const TIME_ZONE = "America/Los_Angeles";

// Pinned with Subresource Integrity, so a changed file on the CDN is refused rather than run.
const CHART_JS = `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.6.1/dist/chart.umd.min.js" integrity="sha384-Emf5ZVIUiarAdhkgtqK+5/Z5qIvM6QoVrS+qAVtfyZVuD5lIHrac0me485+Antp0" crossorigin="anonymous" defer></script>`;

const STYLES = `
  .review .account { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin: 0 0 16px; }
  .review .account p { margin: 0; }
  .mcp-app form.inline { display: inline; margin: 0; }
  .review button.small { font-size: 15px; padding: 6px 10px; }
  .review-section { margin: 0 0 40px; }
  .review-section .chart { position: relative; height: 240px; margin: 0 0 24px; padding: 12px; border: 2px solid var(--gray); border-radius: 4px; background: #fff; }
  .review-section ul.cards { list-style: none; padding: 0; display: grid; gap: 12px; }
  .review-section ul.cards li { padding: 12px 16px; border: 2px solid var(--gray); border-radius: 4px; background: #fff; }
  .review-section ul.cards li p { margin: 4px 0 0; }
  .review-section .card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .review-section .talk-title { font-weight: 500; color: var(--navy); }
  .review-section table { width: 100%; border-collapse: collapse; margin: 0 0 20px; background: #fff; }
  .review-section th, .review-section td { text-align: left; padding: 8px 10px; border-bottom: 2px solid var(--gray); vertical-align: middle; }
  .review-section th { color: var(--navy); font-weight: 500; }
  .review-section form.invite { max-width: 560px; }
`;

const ERRORS: Record<string, string> = {
  signin: "Signing in didn't work. Please try again.",
};

const STATUS: Record<SubmissionStatus, string> = {
  under_review: "Under review",
  accepted: "Accepted",
  rejected: "Not accepted",
  waitlist: "On the waitlist",
};

const VIDEO: Record<SubmissionResult["video_status"], string> = {
  attached: "Video attached.",
  processing: "Video uploaded and still processing.",
  awaiting_recording: "Video not recorded yet.",
  failed: "Video failed.",
  missing: "No video.",
};

const date = (iso: string) => new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: TIME_ZONE });

const signOutForm = `<form method="post" action="/auth/logout?return=/review" class="inline"><button type="submit" class="secondary small">Sign out</button></form>`;

const head = `<style>${APP_STYLES}${FORM_STYLES}${STYLES}</style>`;

function page(status: number, body: string) {
  return sitePage({ status, title: TITLE, head, body, headers: { "Cache-Control": "no-store" } });
}

const notice = (kind: "success" | "error" | "", text: string) =>
  `<div class="notice ${kind}"><p>${escapeHtml(text)}</p></div>`;

export function unavailablePage() {
  return page(200, `<div class="mcp-app review">${notice("", "The review page isn't available right now.")}</div>`);
}

export function signedOutPage(error: string | null) {
  const message = error ? ERRORS[error] ?? ERRORS.signin : undefined;
  return page(200, `<div class="mcp-app review">
  ${message ? notice("error", message) : ""}
  <p>This page is for CascadiaJS 2027 talk reviewers. Sign in with the email address your invitation was sent to. We'll email you a one-time code; there's no password.</p>
  <form method="get" action="/auth/login" class="actions"><input type="hidden" name="return" value="/review"><button type="submit">Sign in with email</button></form>
</div>`);
}

// 200, not 403: Netlify Dev replaces a function's 403 page with its own 404.
export function notAuthorizedPage(email: string) {
  return page(200, `<div class="mcp-app review">
  ${notice("error", "Not authorized.")}
  <p>You're signed in as <strong>${escapeHtml(email)}</strong>, which isn't on the reviewer list. If you were invited with a different email address, sign out and sign in with that one.</p>
  <div class="actions">${signOutForm}</div>
</div>`);
}

const DAY_MS = 86_400_000;
/** The calendar day an instant falls on in Seattle, as YYYY-MM-DD. */
const dayOf = (instant: string | Date) => new Date(instant).toLocaleDateString("en-CA", { timeZone: TIME_ZONE });
/** Formats a YYYY-MM-DD day; it's parsed as UTC midnight, so it's formatted in UTC. */
const formatDay = (day: number, options: Intl.DateTimeFormatOptions) =>
  new Date(day).toLocaleDateString("en-US", { ...options, timeZone: "UTC" });

/** Talks submitted on each day from the first submission through today, including days with none. */
function submissionsPerDay(submissions: SubmissionResult[]) {
  const counts = new Map<string, number>();
  for (const s of submissions) {
    const day = dayOf(s.submitted_at);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const days = [...counts.keys(), dayOf(new Date())].sort();
  const labels: string[] = [];
  const titles: string[] = [];
  const values: number[] = [];
  for (let day = Date.parse(days[0]); day <= Date.parse(days[days.length - 1]); day += DAY_MS) {
    labels.push(formatDay(day, { month: "short", day: "numeric" }));
    titles.push(formatDay(day, { dateStyle: "medium" }));
    values.push(counts.get(new Date(day).toISOString().slice(0, 10)) ?? 0);
  }
  return { labels, titles, values };
}

function chart(submissions: SubmissionResult[]) {
  const data = submissionsPerDay(submissions);
  const busiest = data.values.indexOf(Math.max(...data.values));
  const talks = (n: number) => (n === 1 ? "1 talk" : `${n} talks`);
  const summary = `Talks submitted per day, ${data.titles[0]} to ${data.titles[data.titles.length - 1]}. ` +
    `The busiest day was ${data.titles[busiest]}, with ${talks(data.values[busiest])}.`;
  return `<div class="chart"><canvas id="submissions-chart" role="img" aria-label="${escapeHtml(summary)}"></canvas></div>
  <script type="application/json" id="submissions-per-day">${scriptJson(data)}</script>`;
}

// Runs after Chart.js, which is deferred. If Chart.js can't load, the chart's summary is shown as text.
const CHART_SCRIPT = `
document.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById("submissions-chart");
  if (!canvas) return;
  if (!window.Chart) {
    const fallback = document.createElement("p");
    fallback.className = "muted";
    fallback.textContent = canvas.getAttribute("aria-label");
    canvas.parentElement.replaceWith(fallback);
    return;
  }
  const data = JSON.parse(document.getElementById("submissions-per-day").textContent);
  Chart.defaults.font.family = "freight-sans-pro, sans-serif";
  Chart.defaults.font.size = 14;
  Chart.defaults.color = "#112378";
  new Chart(canvas, {
    type: "line",
    data: {
      labels: data.labels,
      datasets: [{
        label: "Talks submitted",
        data: data.values,
        borderColor: "#0033ff",
        backgroundColor: "rgba(0, 51, 255, 0.1)",
        fill: true,
        pointRadius: data.values.length > 60 ? 0 : 3,
      }],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: (items) => data.titles[items[0].dataIndex] } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } },
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
});
`;

function deleteForm(s: SubmissionResult) {
  return `<form method="post" action="/review/delete" class="inline" data-confirm="Delete &quot;${escapeHtml(s.talk_title)}&quot; (#${escapeHtml(s.submission_id)})? The talk and its video are deleted for good, and the presenter isn't told.">
        <input type="hidden" name="submission_id" value="${escapeHtml(s.submission_id)}">
        <button type="submit" class="secondary small">Delete</button>
      </form>`;
}

function submissionItem(s: SubmissionResult, admin: boolean) {
  const video = s.video_url && /^https?:\/\//i.test(s.video_url)
    ? `${VIDEO[s.video_status]} <a href="${escapeHtml(s.video_url)}" target="_blank" rel="noopener">Watch it</a>`
    : escapeHtml(VIDEO[s.video_status]);
  return `<li>
    <div class="card-head">
      <p class="talk-title">${escapeHtml(s.talk_title)}</p>
      ${admin ? deleteForm(s) : ""}
    </div>
    <p class="muted">#${escapeHtml(s.submission_id)} · Submitted ${escapeHtml(date(s.submitted_at))} · ${escapeHtml(STATUS[s.status] ?? s.status)}</p>
    <p>${escapeHtml(s.talk_description)}</p>
    <p class="muted">Topics: ${escapeHtml(s.topics)}</p>
    <p>${video}</p>
  </li>`;
}

function submissionsSection(submissions: SubmissionResult[], admin: boolean) {
  const count = submissions.length === 1 ? "1 talk" : `${submissions.length} talks`;
  return `<section class="mcp-app review-section">
  <h2>Submissions</h2>
  ${submissions.length ? chart(submissions) : ""}
  <p class="muted">${count}, newest first. Presenter details are hidden so talks are reviewed on their own.</p>
  ${submissions.length ? `<ul class="cards">${submissions.map((s) => submissionItem(s, admin)).join("")}</ul>` : `<p class="muted">None yet.</p>`}
</section>`;
}

function reviewerRow(person: Reviewer, me: Reviewer) {
  const status = person.accepted ? `Accepted ${escapeHtml(date(person.accepted))}` : "Invited";
  const remove = person.email === me.email ? `<span class="muted">You</span>`
    : `<form method="post" action="/review/remove" class="inline" data-confirm="Remove ${escapeHtml(person.email)}? They'll lose access to this page.">
        <input type="hidden" name="email" value="${escapeHtml(person.email)}">
        <button type="submit" class="secondary small">Remove</button>
      </form>`;
  return `<tr>
    <td>${escapeHtml(person.name)}</td>
    <td>${escapeHtml(person.email)}</td>
    <td>${person.role === "admin" ? "Admin" : "Reviewer"}</td>
    <td>${status}</td>
    <td>${remove}</td>
  </tr>`;
}

export type AdminState = {
  reviewers: Reviewer[];
  /** Kept in the invite form when it's shown again with an error. */
  invite?: { name: string; email: string };
};

function reviewersSection(me: Reviewer, admin: AdminState) {
  return `<section class="mcp-app review-section">
  <h2>Reviewers</h2>
  <table>
    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
    <tbody>${admin.reviewers.map((person) => reviewerRow(person, me)).join("")}</tbody>
  </table>
  <form method="post" action="/review/invite" class="invite">
    <h2>Invite a reviewer</h2>
    <p class="muted">They'll get an email with a link to this page and can sign in with that email address.</p>
    <div class="row">
      <label>Name<input type="text" name="name" autocomplete="off" required value="${escapeHtml(admin.invite?.name ?? "")}"></label>
      <label>Email<input type="email" name="email" autocomplete="off" required value="${escapeHtml(admin.invite?.email ?? "")}"></label>
    </div>
    <div class="actions"><button type="submit">Send invitation</button></div>
  </form>
</section>`;
}

const CONFIRM_SCRIPT = `
document.querySelectorAll("form[data-confirm]").forEach((form) => {
  form.addEventListener("submit", (event) => {
    if (!confirm(form.dataset.confirm)) event.preventDefault();
  });
});
`;

export function reviewPage(options: {
  status?: number;
  me: Reviewer;
  submissions: SubmissionResult[];
  admin?: AdminState;
  message?: { kind: "success" | "error" | ""; text: string };
}) {
  const { me, submissions, admin } = options;
  const body = `<div class="mcp-app review">
  <div class="account">
    <p>Signed in as <strong>${escapeHtml(me.name)}</strong> (${escapeHtml(me.email)}), ${me.role === "admin" ? "admin" : "reviewer"}</p>
    ${signOutForm}
  </div>
  ${options.message ? notice(options.message.kind, options.message.text) : ""}
</div>
${admin ? reviewersSection(me, admin) : ""}
${submissionsSection(submissions, Boolean(admin))}`;
  const script = (submissions.length ? CHART_SCRIPT : "") + (admin ? CONFIRM_SCRIPT : "");
  return sitePage({
    status: options.status ?? 200,
    title: TITLE,
    head: submissions.length ? head + CHART_JS : head,
    body,
    script: script || undefined,
    headers: { "Cache-Control": "no-store" },
  });
}
