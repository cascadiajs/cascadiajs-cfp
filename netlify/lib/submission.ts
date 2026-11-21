// The talk form component, followed by the video recorder (recorder.ts). It runs in two
// places:
//
// - Inside agents, as the MCP App for submit-cfp (SUBMISSION_APP_HTML). When the agent
//   calls submit-cfp without every talk detail, it shows the form pre-filled with whatever
//   the agent passed. When the agent passes every detail, the talk is saved straight away
//   and the app goes directly to the recorder.
// - On the /submit page (submit-page.ts), empty, once per talk.
//
// Either way it submits through create-submission (see callTool in app.ts). Then, unless a
// video link was given, it switches to the recorder for the 2-minute video.

import { appDocument } from "./app.js";
import { RECORDER_MARKUP, RECORDER_SCRIPT_BODY, RECORDER_STYLES } from "./recorder.js";

const MAX_DESCRIPTION = 279;

export const SUBMISSION_FORM_STYLES = `
  .submission .counter { justify-self: end; font-weight: 300; font-size: 14px; color: #020800; opacity: .7; }
  .submission .counter.full { color: #ee3e4a; opacity: 1; font-weight: 500; }
  ${RECORDER_STYLES}
`;

export const SUBMISSION_FORM_MARKUP = `
<div class="submission-app">
<div class="submission mcp-app" aria-live="polite">
  <section data-state="waiting"><p class="muted">Loading…</p></section>

  <section data-state="form" hidden>
    <h2>Submit a talk to CascadiaJS 2027</h2>
    <p>Tell us about your talk. You can submit more than one, one at a time.</p>
    <div class="notice error" data-ref="form-error" hidden></div>
    <form novalidate>
      <label><span>Talk title <span class="hint">(please, no colons)</span></span><input type="text" name="talk_title" required></label>
      <label>
        <span>Description <span class="hint">(fewer than 280 characters)</span></span>
        <textarea name="talk_description" maxlength="${MAX_DESCRIPTION}" required></textarea>
        <span class="counter" data-ref="counter">0 / ${MAX_DESCRIPTION}</span>
      </label>
      <label><span>Topics <span class="hint">(comma-separated, for example: AI agents, MCP, web components)</span></span><input type="text" name="topics" required></label>
      <fieldset>
        <legend>Your 2-minute video</legend>
        <label class="choice"><input type="radio" name="video_choice" value="record" checked>Record it now, right here</label>
        <label class="choice"><input type="radio" name="video_choice" value="link">I already have a public link (for example, an unlisted YouTube video)</label>
        <label data-ref="link-field" hidden>Video link<input type="url" name="video_submission_url" placeholder="https://…"></label>
      </fieldset>
      <div class="actions"><button type="submit">Submit talk</button></div>
    </form>
  </section>

  <section data-state="error" hidden>
    <div class="notice error"><p data-ref="error-message"></p></div>
  </section>
</div>
<div data-ref="recorder-wrap" hidden>${RECORDER_MARKUP}</div>
</div>`;

// Runs after RECORDER_SCRIPT_BODY, which defines cfpRecorder. Defines cfpSubmissionForm.
// Call cfpSubmissionForm.connect() (and cfpRecorder.connect()) before open():
//   callTool(name, args)        required: mcpApp.callTool in agents, cfpSite.callTool on the site
//   onSubmitted(talk, result)   called with the submitted details and create-submission's result
const SUBMISSION_FORM_SCRIPT = `
const cfpSubmissionForm = (() => {
  const wrap = document.querySelector(".submission-app");
  const root = wrap.querySelector(".submission");
  const form = root.querySelector("form");
  const recorderWrap = wrap.querySelector('[data-ref="recorder-wrap"]');
  const ref = (name) => root.querySelector('[data-ref="' + name + '"]');
  const show = (state) => root.querySelectorAll("[data-state]").forEach((s) => (s.hidden = s.dataset.state !== state));
  const MAX = ${MAX_DESCRIPTION};

  let settings = { callTool: null, onSubmitted: null };

  function connect(options) {
    settings = { ...settings, ...options };
  }

  function fail(message) {
    ref("error-message").textContent = message;
    show("error");
  }

  // Hands over to the recorder: either to record the video, or to show the finished state.
  function toRecorder(action) {
    root.hidden = true;
    recorderWrap.hidden = false;
    action();
  }

  function updateCounter() {
    const length = form.elements.talk_description.value.length;
    ref("counter").textContent = length + " / " + MAX;
    ref("counter").classList.toggle("full", length >= MAX);
  }

  function updateVideoChoice() {
    const useLink = form.querySelector('[name="video_choice"]:checked').value === "link";
    ref("link-field").hidden = !useLink;
    form.elements.video_submission_url.required = useLink;
  }

  function prefill(values) {
    for (const name of ["talk_title", "talk_description", "topics", "video_submission_url"]) {
      if (values && typeof values[name] === "string") form.elements[name].value = values[name];
    }
    if (values && values.video_submission_url) form.querySelector('[name="video_choice"][value="link"]').checked = true;
    updateCounter();
    updateVideoChoice();
  }

  // Shows the form, empty apart from values.
  function open(values) {
    cfpRecorder.stopCamera();
    recorderWrap.hidden = true;
    root.hidden = false;
    form.reset();
    ref("form-error").hidden = true;
    prefill(values);
    show("form");
    const firstEmpty = ["talk_title", "talk_description", "topics"].map((name) => form.elements[name]).find((el) => !el.value);
    if (firstEmpty) firstEmpty.focus({ preventScroll: true });
  }

  // Moves on from a saved talk: to the recorder, or to the finished state if it has a video.
  function showResult(result, note) {
    if (result.video_url) return toRecorder(() => cfpRecorder.finish(result.video_url, "Your talk is submitted with its video."));
    if (result.recording_token) return toRecorder(() => cfpRecorder.begin(result.recording_token, result.record_url, note || "Your talk is submitted."));
    fail("The submission didn't come back as expected. Please try again.");
  }

  form.addEventListener("input", (event) => {
    if (event.target.name === "talk_description") updateCounter();
    if (event.target.name === "video_choice") updateVideoChoice();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formError = ref("form-error");
    formError.hidden = true;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const value = (name) => form.elements[name].value.trim();
    const useLink = form.querySelector('[name="video_choice"]:checked').value === "link";
    const talk = { talk_title: value("talk_title"), talk_description: value("talk_description"), topics: value("topics") };
    if (useLink) talk.video_submission_url = value("video_submission_url");

    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = "Submitting…";
    try {
      const result = await settings.callTool("create-submission", talk);
      showResult(result, "Your talk is saved. Now record your video to finish.");
      if (settings.onSubmitted) settings.onSubmitted(talk, result);
    } catch (error) {
      formError.textContent = error.message;
      formError.hidden = false;
      formError.scrollIntoView({ block: "nearest" });
    } finally {
      button.disabled = false;
      button.textContent = "Submit talk";
    }
  });

  return { connect, open, showResult, fail };
})();
`;

/** The talk form and recorder scripts, in the order they depend on each other. */
export const SUBMISSION_FORM_SCRIPTS = RECORDER_SCRIPT_BODY + SUBMISSION_FORM_SCRIPT;

// The MCP App glue: opens the form (or the recorder) from submit-cfp's result, routes the
// tool calls through the host and keeps the agent up to date.
const APP_SCRIPT = `
(() => {
  function tellAgent(text, structuredContent) {
    mcpApp.request("ui/update-model-context", { content: [{ type: "text", text }], structuredContent }).catch(() => {});
  }

  cfpRecorder.connect({
    callTool: mcpApp.callTool,
    openStandalone: (url) =>
      mcpApp.request("ui/open-link", { url }).then((result) => {
        if (result && result.isError) throw new Error("Couldn't open the link.");
      }),
    onAttached: (attached) =>
      tellAgent(
        "The presenter recorded their 2-minute CFP video and it is now attached to submission " + attached.submission_id + ": " + attached.video_url,
        attached,
      ),
  });

  cfpSubmissionForm.connect({
    callTool: mcpApp.callTool,
    onSubmitted: (talk, result) => {
      const summary = 'The presenter submitted the talk "' + talk.talk_title + '" to the CascadiaJS 2027 CFP using the submit-cfp form (submission ' + result.submission_id + "). ";
      if (result.video_url) return tellAgent(summary + "Video: " + result.video_url, { ...talk, ...result });
      tellAgent(
        summary + "Its 2-minute video is still to be recorded in the recorder shown. If they close it before finishing, they can record it at " + result.record_url,
        { ...talk, submission_id: result.submission_id, submitted_at: result.submitted_at, record_url: result.record_url },
      );
    },
  });

  function onToolResult(result) {
    const data = result.structuredContent || {};
    if (result.isError) return cfpSubmissionForm.fail(mcpApp.text(result) || "The submission failed.");
    if (data.status === "needs_details") return cfpSubmissionForm.open(data.prefill);
    cfpSubmissionForm.showResult(data);
  }

  if (!mcpApp.embedded) return cfpSubmissionForm.fail("This form only works inside an AI agent.");
  mcpApp.on("ui/notifications/tool-result", onToolResult);
  mcpApp.on("ui/notifications/tool-cancelled", () => cfpSubmissionForm.fail("The submission was cancelled."));
  mcpApp.on("ui/resource-teardown", cfpRecorder.stopCamera);
  mcpApp.connect({ name: "cascadiajs-cfp-submission", version: "1.0.0" }).catch(() => cfpSubmissionForm.fail("Couldn't connect to your agent."));
})();
`;

export const SUBMISSION_APP_HTML = appDocument(SUBMISSION_FORM_STYLES, SUBMISSION_FORM_MARKUP, SUBMISSION_FORM_SCRIPTS + APP_SCRIPT);
