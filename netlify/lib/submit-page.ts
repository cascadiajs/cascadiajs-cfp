// The /submit page: the website's way to submit a talk, for presenters who'd rather not
// use an agent. It shows the same components as the MCP Apps (profile.ts, submission.ts
// and recorder.ts) in the same order: profile (first time), talk, then video. They call
// the same tools as in agents through cfpSite.callTool (app.ts), and the page lists the
// presenter's talks like list-submissions.

import { APP_STYLES, FORM_STYLES, SITE_API_SCRIPT } from "./app.js";
import type { listSubmissions, ProfileInput } from "./cfp.js";
import { escapeHtml, scriptJson, sitePage } from "./page.js";
import { PROFILE_FORM_MARKUP, PROFILE_FORM_SCRIPT, PROFILE_FORM_STYLES } from "./profile.js";
import { SUBMISSION_FORM_MARKUP, SUBMISSION_FORM_SCRIPTS, SUBMISSION_FORM_STYLES } from "./submission.js";

const TITLE = "Submit a talk";

const STYLES = `
  .web-submit .account { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin: 0 0 16px; }
  .web-submit .account p { margin: 0; }
  .web-submit form.inline { margin: 0; }
  .web-submit button.small { font-size: 15px; padding: 6px 10px; }
  .page-step { margin: 0 0 32px; }
  .page-step > .mcp-app { margin-top: 12px; }
  .my-submissions ul { list-style: none; padding: 0; display: grid; gap: 12px; }
  .my-submissions li { padding: 12px 16px; border: 2px solid var(--gray); border-radius: 4px; background: #fff; }
  .my-submissions li p { margin: 4px 0 0; }
  .my-submissions .talk-title { font-weight: 500; color: var(--navy); }
`;

const ERRORS: Record<string, string> = {
  signin: "Signing in didn't work. Please try again.",
};

const agentLink = `<a href="/#submit-with-your-ai-agent">submit with your AI agent</a>`;

function signedOutBody(configured: boolean, error: string | null) {
  if (!configured) {
    return `<div class="mcp-app web-submit">
  <div class="notice"><p>Submitting on the website isn't available right now. Please ${agentLink} instead, or <a href="mailto:info@cascadiajs.com">email us</a>.</p></div>
</div>`;
  }
  const message = error ? ERRORS[error] ?? ERRORS.signin : undefined;
  return `<div class="mcp-app web-submit">
  ${message ? `<div class="notice error"><p>${escapeHtml(message)}</p></div>` : ""}
  <p>The easiest way to apply is to ${agentLink}. If you'd rather not use an agent, fill in the same forms here: your profile, your talk and your 2-minute video.</p>
  <p>Sign in with your email address. We'll email you a one-time code; there's no password. Use the same email as your agent and you'll see the same profile and talks.</p>
  <form method="get" action="/auth/login" class="actions"><button type="submit">Sign in with email</button></form>
</div>`;
}

const signedInBody = (email: string) => `
<div class="mcp-app web-submit">
  <div class="account">
    <p>Signed in as <strong>${escapeHtml(email)}</strong></p>
    <form method="post" action="/auth/logout" class="inline"><button type="submit" class="secondary small">Sign out</button></form>
  </div>
  <div class="notice success" data-ref="page-notice" hidden></div>
</div>

<div class="page-step" data-ref="page-profile" hidden>
  ${PROFILE_FORM_MARKUP}
  <div class="mcp-app"><div class="actions" data-ref="page-back" hidden><button type="button" class="secondary" data-action="page-back">Back to your talk</button></div></div>
</div>

<div class="page-step" data-ref="page-talk" hidden>
  ${SUBMISSION_FORM_MARKUP}
  <div class="mcp-app"><div class="actions">
    <button type="button" data-action="page-another" hidden>Submit another talk</button>
    <button type="button" class="secondary" data-action="page-edit-profile">Edit your profile</button>
  </div></div>
</div>

<section class="mcp-app my-submissions">
  <h2>Your submissions</h2>
  <p class="muted" data-ref="page-no-submissions">None yet.</p>
  <ul data-ref="page-submissions"></ul>
</section>`;

// The page's glue: which step shows, and the submissions list. The forms do the rest.
const PAGE_SCRIPT = `
(() => {
  const state = JSON.parse(document.getElementById("cfp-state").textContent);
  const $ = (name) => document.querySelector('[data-ref="' + name + '"]');
  const button = (action) => document.querySelector('[data-action="' + action + '"]');
  let profile = state.profile || {};
  let profileComplete = state.profile_complete;

  function notice(text) {
    $("page-notice").textContent = text || "";
    $("page-notice").hidden = !text;
  }

  function showProfile() {
    cfpRecorder.stopCamera();
    $("page-talk").hidden = true;
    $("page-profile").hidden = false;
    $("page-back").hidden = !profileComplete;
    notice("");
    cfpProfileForm.open(state.email, profile);
  }

  function showTalk(message) {
    $("page-profile").hidden = true;
    $("page-talk").hidden = false;
    notice(message);
  }

  function newTalk(message) {
    cfpSubmissionForm.open({});
    button("page-another").hidden = true;
    button("page-edit-profile").hidden = false;
    showTalk(message);
  }

  function finished() {
    button("page-another").hidden = false;
    refreshSubmissions();
  }

  // Recording links for talks still waiting for their video, so a presenter who leaves
  // the recorder can come back to it from the list. Only this browser has them: the
  // server keeps just a hash of each token.
  const recordLinks = {
    KEY: "cfp-record-links",
    all() {
      try { return JSON.parse(localStorage.getItem(this.KEY)) || {}; } catch { return {}; }
    },
    write(links) {
      try { localStorage.setItem(this.KEY, JSON.stringify(links)); } catch {}
    },
    add(id, url) {
      this.write({ ...this.all(), [id]: url });
    },
    // Keeps only the links for talks that still need their video.
    forList(submissions) {
      const waiting = new Set(submissions.filter((s) => s.video_status === "awaiting_recording").map((s) => s.submission_id));
      const links = Object.fromEntries(Object.entries(this.all()).filter(([id]) => waiting.has(id)));
      this.write(links);
      return links;
    },
  };

  const REVIEW = { under_review: "Under review", accepted: "Accepted", rejected: "Not accepted", waitlist: "On the waitlist" };
  const VIDEO = {
    attached: "Video attached.",
    processing: "Video uploaded and still processing.",
    awaiting_recording: "Video not recorded yet.",
    failed: "Video failed.",
    missing: "No video: the recording wasn't finished in time. Submit the talk again with a video link or a new recording.",
  };

  function link(text, href) {
    const a = document.createElement("a");
    a.textContent = text;
    if (/^https?:\\/\\//i.test(href)) a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }

  function line(text, className) {
    const p = document.createElement("p");
    p.textContent = text;
    if (className) p.className = className;
    return p;
  }

  function renderSubmissions(submissions) {
    const list = $("page-submissions");
    list.replaceChildren();
    $("page-no-submissions").hidden = submissions.length > 0;
    const links = recordLinks.forList(submissions);
    for (const s of submissions) {
      const item = document.createElement("li");
      const submitted = new Date(s.submitted_at).toLocaleDateString(undefined, { dateStyle: "medium" });
      item.append(
        line(s.talk_title, "talk-title"),
        line("Submitted " + submitted + ". " + (REVIEW[s.status] || s.status) + ".", "muted"),
        line(s.talk_description),
        line("Topics: " + s.topics, "muted"),
      );
      const video = line(VIDEO[s.video_status] + (s.video_error ? " " + s.video_error : "") + " ");
      if (s.video_url) video.append(link("Watch it", s.video_url));
      else if (links[s.submission_id]) video.append(link("Record it now", links[s.submission_id]));
      item.append(video);
      list.append(item);
    }
  }

  async function refreshSubmissions() {
    try {
      const response = await fetch("/api/submissions", { credentials: "same-origin" });
      if (response.ok) renderSubmissions((await response.json()).submissions);
    } catch {}
  }

  cfpProfileForm.connect({
    callTool: cfpSite.callTool,
    onSaved: (result, data) => {
      profile = data;
      if (profileComplete) return showTalk("Your profile is saved.");
      profileComplete = true;
      newTalk("Your profile is saved. Now tell us about your talk.");
    },
  });

  cfpSubmissionForm.connect({
    callTool: cfpSite.callTool,
    onSubmitted: (talk, result) => {
      notice("");
      button("page-edit-profile").hidden = true;
      if (result.record_url) recordLinks.add(result.submission_id, result.record_url);
      if (result.video_url) finished();
      else refreshSubmissions();
    },
  });

  cfpRecorder.connect({ callTool: cfpSite.callTool, doneNote: "", onAttached: finished });

  button("page-back").addEventListener("click", () => showTalk());
  button("page-edit-profile").addEventListener("click", showProfile);
  button("page-another").addEventListener("click", () => newTalk());

  renderSubmissions(state.submissions);
  if (profileComplete) newTalk();
  else showProfile();
})();
`;

const head = `<style>${APP_STYLES}${FORM_STYLES}${PROFILE_FORM_STYLES}${SUBMISSION_FORM_STYLES}${STYLES}</style>`;

export function signedOutPage(options: { configured: boolean; error: string | null }) {
  return sitePage({
    status: 200,
    title: TITLE,
    head,
    body: signedOutBody(options.configured, options.error),
    headers: { "Cache-Control": "no-store" },
  });
}

export function signedInPage(state: {
  email: string;
  profile: Partial<ProfileInput>;
  profile_complete: boolean;
  submissions: Awaited<ReturnType<typeof listSubmissions>>;
}) {
  return sitePage({
    status: 200,
    title: TITLE,
    head,
    body: `${signedInBody(state.email)}\n<script type="application/json" id="cfp-state">${scriptJson(state)}</script>`,
    script: SITE_API_SCRIPT + PROFILE_FORM_SCRIPT + SUBMISSION_FORM_SCRIPTS + PAGE_SCRIPT,
    headers: { "Cache-Control": "no-store" },
  });
}
