// The profile form, shown as the MCP App for create-profile when the signed-in presenter's
// profile is missing required details. It is pre-filled with anything saved before and
// whatever the agent passed, and saves through the app-only save-profile tool. The email
// comes from sign-in, so it is shown but not editable. Agents that can't show MCP Apps
// never see it: they ask for the missing details in chat and call create-profile again.

import { appDocument } from "./app.js";

const STYLES = `
  .profile-form .signed-in { font-size: 15px; }
`;

const MARKUP = `
<div class="profile-form mcp-app" aria-live="polite">
  <section data-state="waiting"><p class="muted">Loading the profile form…</p></section>

  <section data-state="form" hidden>
    <h2>Your CascadiaJS 2027 CFP profile</h2>
    <p class="signed-in">Signed in as <strong data-ref="form-email"></strong>. Fill in the rest to finish your profile.</p>
    <div class="notice error" data-ref="form-error" hidden></div>
    <form novalidate>
      <label>Full name<input type="text" name="full_name" autocomplete="name" required></label>
      <div class="row">
        <label>City<input type="text" name="city" autocomplete="address-level2" required></label>
        <label><span>State or province <span class="hint">(optional)</span></span><input type="text" name="state" autocomplete="address-level1"></label>
        <label>Country<input type="text" name="country" autocomplete="country-name" required></label>
      </div>
      <fieldset>
        <legend>Where can we find you online? <span class="hint">(all optional)</span></legend>
        <div class="row">
          <label>X<input type="url" name="x_url" placeholder="https://x.com/…"></label>
          <label>LinkedIn<input type="url" name="linkedin_url" placeholder="https://linkedin.com/in/…"></label>
        </div>
        <div class="row">
          <label>Bluesky<input type="url" name="bluesky_url" placeholder="https://bsky.app/profile/…"></label>
          <label>Other<input type="url" name="other_url" placeholder="https://…"></label>
        </div>
      </fieldset>
      <label>How did you hear about our CFP?<input type="text" name="referral" required></label>
      <fieldset>
        <legend>Can your company cover your travel and lodging?</legend>
        <div class="choices">
          <label class="choice"><input type="radio" name="travel_covered" value="true" required>Yes</label>
          <label class="choice"><input type="radio" name="travel_covered" value="false">No</label>
        </div>
      </fieldset>
      <label class="choice"><input type="checkbox" name="confirmation" required>I can speak at CascadiaJS 2027 in Seattle, WA on June 7 or 8, 2027.</label>
      <div class="actions"><button type="submit">Save profile</button></div>
    </form>
  </section>

  <section data-state="done" hidden>
    <div class="notice success">
      <p><strong>Your profile is saved</strong> for <span data-ref="email"></span>. Next, your agent will help you submit a talk.</p>
    </div>
  </section>

  <section data-state="error" hidden>
    <div class="notice error"><p data-ref="error-message"></p></div>
  </section>
</div>`;

const SCRIPT = `
(() => {
  const root = document.querySelector(".profile-form");
  const form = root.querySelector("form");
  const ref = (name) => root.querySelector('[data-ref="' + name + '"]');
  const show = (state) => root.querySelectorAll("[data-state]").forEach((s) => (s.hidden = s.dataset.state !== state));
  const OPTIONAL = ["state", "x_url", "linkedin_url", "bluesky_url", "other_url"];

  function fail(message) {
    ref("error-message").textContent = message;
    show("error");
  }

  function prefill(values) {
    for (const [name, value] of Object.entries(values || {})) {
      if (value === undefined || value === null) continue;
      const field = form.elements[name];
      if (!field) continue;
      if (name === "travel_covered") form.querySelector('[name="travel_covered"][value="' + value + '"]').checked = true;
      else if (name === "confirmation") field.checked = value === true;
      else field.value = value;
    }
  }

  function saved(email) {
    ref("email").textContent = email;
    show("done");
  }

  function onToolResult(result) {
    const data = result.structuredContent || {};
    if (result.isError) return fail(mcpApp.text(result) || "Saving the profile failed.");
    if (data.status === "profile_complete") return saved(data.email_address);
    ref("form-email").textContent = data.email_address || "";
    prefill(data.prefill);
    show("form");
    const firstEmpty = [...form.elements].find((el) => el.required && !el.value && el.type !== "radio" && el.type !== "checkbox");
    if (firstEmpty) firstEmpty.focus({ preventScroll: true });
  }

  // Tells the agent the profile is saved, then sends a chat message so it moves on to the
  // talk: ui/update-model-context alone waits for the presenter's next message.
  async function continueToTalk(result) {
    await mcpApp.request("ui/update-model-context", {
      content: [{
        type: "text",
        text: "The presenter saved their CascadiaJS 2027 CFP profile (" + result.email_address + ") using the create-profile form. Next, call submit-cfp to submit a talk.",
      }],
      structuredContent: result,
    }).catch(() => {});
    // content is an array of blocks, as the ext-apps SDK schema requires (the spec's
    // prose example shows a single block, which hosts validating with the SDK reject).
    await mcpApp.request("ui/message", {
      role: "user",
      content: [{ type: "text", text: "I've saved my profile. Now help me submit a talk to the CascadiaJS 2027 CFP." }],
    }).catch((error) => console.warn("ui/message failed:", error.message));
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formError = ref("form-error");
    formError.hidden = true;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const data = Object.fromEntries(
      [...new FormData(form)].map(([name, value]) => [name, typeof value === "string" ? value.trim() : value]),
    );
    for (const name of OPTIONAL) if (!data[name]) delete data[name];
    data.travel_covered = data.travel_covered === "true";
    data.confirmation = form.elements.confirmation.checked;

    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      const result = await mcpApp.callTool("save-profile", data);
      saved(result.email_address);
      continueToTalk(result);
    } catch (error) {
      formError.textContent = error.message;
      formError.hidden = false;
      formError.scrollIntoView({ block: "nearest" });
    } finally {
      button.disabled = false;
      button.textContent = "Save profile";
    }
  });

  if (!mcpApp.embedded) return fail("This form only works inside an AI agent.");
  mcpApp.on("ui/notifications/tool-result", onToolResult);
  mcpApp.on("ui/notifications/tool-cancelled", () => fail("Saving your profile was cancelled."));
  mcpApp.connect({ name: "cascadiajs-cfp-profile", version: "1.0.0" }).catch(() => fail("Couldn't connect to your agent."));
})();
`;

export const PROFILE_APP_HTML = appDocument(STYLES, MARKUP, SCRIPT);
