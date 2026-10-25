// The 2-minute video recorder. The same markup and script run in two places:
//
// - Inside the agent, as the last step of the submit-cfp MCP App (submission.ts), which
//   calls cfpRecorder.begin() with the recording token once the talk is saved. There it
//   uploads through the app-only tools create-video-upload and attach-video.
// - At /record#token=…, as a fallback for agents that can't show MCP Apps or that
//   block the camera. There it reads the token from the fragment and calls the REST API.
//
// Either way the browser PUTs the recording straight to Mux; it never passes through
// a Netlify Function (request bodies there are capped at about 6 MB).

import { APP_BRIDGE_SCRIPT } from "./app.js";

export const RECORDER_STYLES = `
  .recorder video { display: block; width: 100%; aspect-ratio: 16 / 9; background: #020800; border-radius: 4px; margin: 0 0 12px; object-fit: cover; }
  .recorder .stage { position: relative; }
  .recorder .timer { position: absolute; top: 10px; left: 10px; padding: 4px 10px; border-radius: 4px; background: rgb(2 8 0 / 70%); color: #fff; font-family: mono45-headline, ui-monospace, monospace; font-size: 18px; }
  .recorder .timer.live::before { content: ""; display: inline-block; width: 10px; height: 10px; margin-right: 8px; border-radius: 50%; background: #ee3e4a; }
  .recorder .progress { height: 10px; background: var(--gray); border-radius: 5px; overflow: hidden; margin: 0 0 12px; }
  .recorder .progress div { height: 100%; width: 0; background: var(--blue); transition: width .2s; }
`;

export const RECORDER_MARKUP = `
<div class="recorder mcp-app" aria-live="polite">
  <section data-state="waiting"><p class="muted">Loading the recorder…</p></section>

  <section data-state="intro" hidden>
    <div class="notice success" data-ref="intro-note" hidden></div>
    <h2>Record your 2-minute video</h2>
    <p class="muted">Recording links expire after 24 hours. Complete your upload within 15 minutes of starting it.</p>
    <p>Describe your talk idea informally. It's not a mini-talk, and we won't make it public. Try to cover:</p>
    <ul>
      <li>Who you are: name, company, role</li>
      <li>What your talk is about, big picture</li>
      <li>Why it's exciting, with details (technologies, techniques)</li>
    </ul>
    <div class="actions"><button type="button" data-action="camera">Turn on camera</button></div>
  </section>

  <section data-state="camera" hidden>
    <div class="stage"><video data-ref="live" autoplay muted playsinline></video><span class="timer" data-ref="timer">2:00</span></div>
    <div class="actions">
      <button type="button" data-action="record">Start recording</button>
      <button type="button" data-action="stop" hidden>Stop</button>
    </div>
    <p class="muted">Recording stops automatically at 2:00.</p>
  </section>

  <section data-state="review" hidden>
    <h2>How does it look?</h2>
    <video data-ref="playback" controls playsinline></video>
    <div class="actions">
      <button type="button" data-action="upload">Use this video</button>
      <button type="button" class="secondary" data-action="camera">Record again</button>
    </div>
  </section>

  <section data-state="uploading" hidden>
    <h2 data-ref="upload-title">Uploading your video…</h2>
    <div class="progress"><div data-ref="progress"></div></div>
    <p class="muted">Keep this open until it finishes.</p>
  </section>

  <section data-state="done" hidden>
    <div class="notice success"><p data-ref="done-message">Your video is attached to your submission.</p><p><a data-ref="video-link" target="_blank" rel="noopener">Watch it</a></p></div>
  </section>

  <section data-state="error" hidden>
    <div class="notice error"><p data-ref="error-message"></p></div>
    <div class="actions">
      <button type="button" data-action="retry" hidden>Try again</button>
      <button type="button" class="secondary" data-action="open-standalone" hidden>Open the recorder in your browser</button>
    </div>
    <p class="muted" data-ref="standalone-link" hidden></p>
  </section>
</div>`;

// Runs after APP_BRIDGE_SCRIPT, which defines mcpApp. Defines cfpRecorder.
export const RECORDER_SCRIPT_BODY = `
const cfpRecorder = (() => {
  const MAX_SECONDS = 120;
  const root = document.querySelector(".recorder");
  const ref = (name) => root.querySelector('[data-ref="' + name + '"]');
  const show = (state) => root.querySelectorAll("[data-state]").forEach((s) => (s.hidden = s.dataset.state !== state));
  const embedded = mcpApp.embedded;

  let uploaded = false;
  let token = null, recordUrl = null, stream = null, recorder = null, recording = null, retry = null;

  function fail(message, options = {}) {
    stopCamera();
    ref("error-message").textContent = message;
    retry = options.retry || null;
    root.querySelector('[data-action="retry"]').hidden = !retry;
    const offerStandalone = Boolean(options.standalone && embedded && recordUrl);
    root.querySelector('[data-action="open-standalone"]').hidden = !offerStandalone;
    show("error");
  }

  async function callServer(action) {
    if (embedded) {
      const name = action === "upload" ? "create-video-upload" : "attach-video";
      return mcpApp.callTool(name, { recording_token: token });
    }
    const response = await fetch("/api/recordings/" + (action === "upload" ? "upload" : "complete"), {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || "Something went wrong."), { status: response.status });
    return body;
  }

  // Starts the recorder for a saved submission. note is an optional line shown above it.
  function begin(recordingToken, url, note) {
    uploaded = false;
    token = recordingToken;
    recordUrl = url || null;
    ref("intro-note").textContent = note || "";
    ref("intro-note").hidden = !note;
    show("intro");
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      return fail("Recording isn't available here.", { standalone: true });
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
    } catch (error) {
      const blocked = error && (error.name === "NotAllowedError" || error.name === "SecurityError");
      return fail(
        blocked ? "Camera or microphone access was blocked." : "Couldn't start your camera and microphone.",
        { retry: startCamera, standalone: true },
      );
    }
    ref("live").srcObject = stream;
    ref("timer").textContent = "2:00";
    ref("timer").classList.remove("live");
    root.querySelector('[data-action="record"]').hidden = false;
    root.querySelector('[data-action="stop"]').hidden = true;
    show("camera");
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  function startRecording() {
    const mimeType = ["video/mp4;codecs=avc1,mp4a", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
      .find((type) => MediaRecorder.isTypeSupported(type));
    const chunks = [];
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2500000 });
    recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
    recorder.onstop = () => {
      clearInterval(tick);
      stopCamera();
      uploaded = false;
      recording = new Blob(chunks, { type: recorder.mimeType });
      const playback = ref("playback");
      if (playback.src) URL.revokeObjectURL(playback.src);
      playback.src = URL.createObjectURL(recording);
      show("review");
    };
    const started = Date.now();
    const timer = ref("timer");
    timer.classList.add("live");
    const tick = setInterval(() => {
      const left = Math.max(0, MAX_SECONDS - Math.floor((Date.now() - started) / 1000));
      timer.textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
      if (left === 0 && recorder.state === "recording") recorder.stop();
    }, 250);
    recorder.start(1000);
    root.querySelector('[data-action="record"]').hidden = true;
    root.querySelector('[data-action="stop"]').hidden = false;
  }

  function put(url, blob) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) ref("progress").style.width = Math.round((event.loaded / event.total) * 100) + "%";
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("Upload failed (" + xhr.status + ").")));
      xhr.onerror = () => reject(new Error("Upload failed. Check your connection."));
      xhr.send(blob);
    });
  }

  async function upload() {
    ref("progress").style.width = "0";
    ref("upload-title").textContent = "Uploading your video…";
    show("uploading");
    try {
      if (!uploaded) {
        const result = await callServer("upload");
        if (!result.uploaded) await put(result.upload_url, recording);
        uploaded = true;
      }
      ref("upload-title").textContent = "Attaching it to your submission…";
      let attached = null;
      for (let attempt = 0; attempt < 5 && !attached; attempt++) {
        try {
          attached = await callServer("complete");
        } catch (error) {
          // Still processing: Mux usually needs a few seconds after the upload.
          if (!/processing/i.test(error.message) || attempt === 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
      finish(attached.video_url, "Your video is attached to your submission.");
      if (embedded) {
        mcpApp.request("ui/update-model-context", {
          content: [{ type: "text", text: "The presenter recorded their 2-minute CFP video and it is now attached to submission " + attached.submission_id + ": " + attached.video_url }],
          structuredContent: attached,
        }).catch(() => {});
      }
    } catch (error) {
      fail(error.message, { retry: upload });
    }
  }

  function finish(videoUrl, message) {
    const link = ref("video-link");
    link.removeAttribute("href");
    // Validate again at the link sink, including results containing previously saved URLs.
    let url;
    try {
      if (typeof videoUrl !== "string" || !/^https?:\\/\\//i.test(videoUrl.trim())) throw new Error();
      url = new URL(videoUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      return fail("The video link must be an absolute HTTP or HTTPS URL.");
    }
    ref("done-message").textContent = message + " You can close this window.";
    link.href = url.href;
    show("done");
  }

  root.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "camera") startCamera();
    else if (action === "record") startRecording();
    else if (action === "stop" && recorder && recorder.state === "recording") recorder.stop();
    else if (action === "upload") upload();
    else if (action === "retry" && retry) retry();
    else if (action === "open-standalone") {
      mcpApp.request("ui/open-link", { url: recordUrl })
        .then((result) => { if (result && result.isError) throw new Error(); })
        .catch(() => {
          const note = ref("standalone-link");
          note.textContent = "Open this link in your browser: " + recordUrl;
          note.hidden = false;
        });
    }
  });

  if (!embedded) {
    const linkToken = new URLSearchParams(location.hash.slice(1)).get("token");
    if (linkToken) begin(linkToken, null);
    else fail("This link is missing its recording token. Use the link your agent gave you.");
  }

  return { begin, finish, fail, stopCamera };
})();
`;

/** The recorder's script, including the host bridge (unused on the /record page). */
export const RECORDER_SCRIPT = APP_BRIDGE_SCRIPT + RECORDER_SCRIPT_BODY;
