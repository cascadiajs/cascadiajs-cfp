// The submission app, shown as the MCP App for submit-cfp. When the agent calls
// submit-cfp without every talk detail, it shows a form pre-filled with whatever the agent
// passed (title, description, topics, optional video link) and submits through the
// app-only create-submission tool. Then, unless a video link was given, it switches to the
// recorder (recorder.ts) for the 2-minute video. When the agent passes every detail, the
// talk is saved straight away and the app goes directly to the recorder.

import { appDocument } from "./app.js";
import { RECORDER_MARKUP, RECORDER_SCRIPT_BODY, RECORDER_STYLES } from "./recorder.js";

const MAX_DESCRIPTION = 279;

const STYLES = `
  .submission .counter { justify-self: end; font-weight: 300; font-size: 14px; color: #020800; opacity: .7; }
  .submission .counter.full { color: #ee3e4a; opacity: 1; font-weight: 500; }
`;

const MARKUP = `
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
<div data-ref="recorder-wrap" hidden>${RECORDER_MARKUP}</div>`;

// Runs after RECORDER_SCRIPT_BODY, which defines cfpRecorder.
const SCRIPT = `
(() => {
  const root = document.querySelector(".submission");
  const form = root.querySelector("form");
  const ref = (name) => document.querySelector('[data-ref="' + name + '"]');
  const show = (state) => root.querySelectorAll("[data-state]").forEach((s) => (s.hidden = s.dataset.state !== state));
  const MAX = ${MAX_DESCRIPTION};

  function fail(message) {
    ref("error-message").textContent = message;
    show("error");
  }

  // Hands over to the recorder: either to record the video, or to show the finished state.
  function toRecorder(action) {
    root.hidden = true;
    ref("recorder-wrap").hidden = false;
    action();
  }

  function tellAgent(text, structuredContent) {
    mcpApp.request("ui/update-model-context", { content: [{ type: "text", text }], structuredContent }).catch(() => {});
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

  function onToolResult(result) {
    const data = result.structuredContent || {};
    if (result.isError) return fail(mcpApp.text(result) || "The submission failed.");
    if (data.status === "needs_details") {
      prefill(data.prefill);
      show("form");
      const firstEmpty = ["talk_title", "talk_description", "topics"].map((name) => form.elements[name]).find((el) => !el.value);
      if (firstEmpty) firstEmpty.focus({ preventScroll: true });
      return;
    }
    if (data.video_url) return toRecorder(() => cfpRecorder.finish(data.video_url, "Your talk is submitted with its video."));
    if (data.recording_token) return toRecorder(() => cfpRecorder.begin(data.recording_token, data.record_url, "Your talk is submitted."));
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
      const result = await mcpApp.callTool("create-submission", talk);
      const summary = 'The presenter submitted the talk "' + talk.talk_title + '" to the CascadiaJS 2027 CFP using the submit-cfp form (submission ' + result.submission_id + "). ";
      if (result.video_url) {
        toRecorder(() => cfpRecorder.finish(result.video_url, "Your talk is submitted with its video."));
        tellAgent(summary + "Video: " + result.video_url, { ...talk, ...result });
      } else {
        toRecorder(() => cfpRecorder.begin(result.recording_token, result.record_url, "Your talk is saved. Now record your video to finish."));
        tellAgent(
          summary + "Its 2-minute video is still to be recorded in the recorder shown. If they close it before finishing, they can record it at " + result.record_url,
          { ...talk, submission_id: result.submission_id, submitted_at: result.submitted_at, record_url: result.record_url },
        );
      }
    } catch (error) {
      formError.textContent = error.message;
      formError.hidden = false;
      formError.scrollIntoView({ block: "nearest" });
    } finally {
      button.disabled = false;
      button.textContent = "Submit talk";
    }
  });

  if (!mcpApp.embedded) return fail("This form only works inside an AI agent.");
  mcpApp.on("ui/notifications/tool-result", onToolResult);
  mcpApp.on("ui/notifications/tool-cancelled", () => fail("The submission was cancelled."));
  mcpApp.on("ui/resource-teardown", cfpRecorder.stopCamera);
  mcpApp.connect({ name: "cascadiajs-cfp-submission", version: "1.0.0" }).catch(() => fail("Couldn't connect to your agent."));
})();
`;

export const SUBMISSION_APP_HTML = appDocument(RECORDER_STYLES + STYLES, MARKUP, RECORDER_SCRIPT_BODY + SCRIPT);
