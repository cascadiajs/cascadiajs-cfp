// Shared pieces for the CFP's forms: the profile form (profile.ts), the talk form
// (submission.ts) and the video recorder (recorder.ts). Each form is a component, markup
// plus a script, that runs in two places:
//
// - Inside agents, as an MCP App (io.modelcontextprotocol/ui, 2026-01-26): a self-contained
//   HTML document the host loads into a sandboxed iframe. It calls this server's tools
//   through the host with mcpApp.callTool (APP_BRIDGE_SCRIPT).
// - On this site's pages (/submit and /record), where cfpSite.callTool (SITE_API_SCRIPT)
//   makes the same tool calls as requests to this site's API.
//
// The components only ever see a callTool function, so they work the same in both.

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** Styles shared by every component, scoped to its root element (`.mcp-app`, in agents and on the site). */
export const APP_STYLES = `
  .mcp-app { --navy: #112378; --blue: #0033ff; --cream: #fff5cc; --gray: #cfd3e4; --mint: #ccf1db; }
  .mcp-app [hidden] { display: none !important; }
  .mcp-app h2 { margin: 0 0 12px; font-family: freight-macro-pro, sans-serif; font-size: 24px; font-weight: 500; color: var(--navy); line-height: 1.125em; }
  .mcp-app p { margin: 0 0 12px; line-height: 1.5; }
  .mcp-app ul { margin: 0 0 12px; padding-inline-start: 1.25em; line-height: 1.5; }
  .mcp-app .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
  .mcp-app button { font-family: mono45-headline, sans-serif; font-size: 18px; font-weight: 500; line-height: 1; padding: 10px 14px; border: 3px solid var(--blue); background: var(--blue); color: var(--cream); cursor: pointer; }
  .mcp-app button:hover { background: var(--navy); border-color: var(--navy); }
  .mcp-app button.secondary { background: transparent; color: var(--blue); }
  .mcp-app button.secondary:hover { color: var(--navy); }
  .mcp-app button:disabled { opacity: .5; cursor: default; }
  .mcp-app .notice { padding: 12px 16px; border-radius: 4px; background: var(--gray); color: var(--navy); font-weight: 500; margin: 0 0 12px; }
  .mcp-app .notice p:last-child { margin-bottom: 0; }
  .mcp-app .notice.success { background: var(--mint); }
  .mcp-app .notice.error { background: #ee3e4a; color: #fff; }
  .mcp-app .notice a { color: inherit; }
  .mcp-app .muted { opacity: .75; font-size: 15px; }
`;

/** Form controls shared by the profile and submission forms. */
export const FORM_STYLES = `
  .mcp-app form { display: grid; gap: 14px; }
  .mcp-app fieldset { border: 0; margin: 0; padding: 0; display: grid; gap: 14px; }
  .mcp-app legend { padding: 0; margin: 0 0 4px; font-family: freight-macro-pro, sans-serif; font-size: 18px; font-weight: 500; color: var(--navy); }
  .mcp-app .row { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
  .mcp-app label { display: grid; gap: 4px; font-weight: 500; color: var(--navy); font-size: 15px; }
  .mcp-app .hint { font-weight: 300; font-size: 15px; color: #020800; opacity: .7; }
  .mcp-app input[type="text"], .mcp-app input[type="email"], .mcp-app input[type="url"] {
    font: inherit; font-size: 16px; font-weight: 400; padding: 9px 10px; border: 2px solid var(--gray); border-radius: 4px; background: #fff; color: #020800; width: 100%; box-sizing: border-box;
  }
  .mcp-app input:focus-visible { outline: 3px solid var(--blue); outline-offset: 0; border-color: var(--blue); }
  .mcp-app input:user-invalid { border-color: #ee3e4a; }
  .mcp-app .choice { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; color: #020800; font-size: 16px; }
  .mcp-app .choice input { margin-top: 4px; width: 18px; height: 18px; accent-color: var(--blue); }
  .mcp-app .choices { display: flex; gap: 20px; }
  .mcp-app textarea { font: inherit; font-size: 16px; font-weight: 400; padding: 9px 10px; border: 2px solid var(--gray); border-radius: 4px; background: #fff; color: #020800; width: 100%; box-sizing: border-box; resize: vertical; min-height: 96px; line-height: 1.4; }
  .mcp-app textarea:focus-visible { outline: 3px solid var(--blue); outline-offset: 0; border-color: var(--blue); }
  .mcp-app textarea:user-invalid { border-color: #ee3e4a; }
`;

/**
 * Defines `mcpApp`, a minimal host bridge: JSON-RPC 2.0 over postMessage with the parent
 * window. Call `mcpApp.connect()` once handlers are registered with `mcpApp.on()`.
 */
export const APP_BRIDGE_SCRIPT = `
const mcpApp = (() => {
  const embedded = window.parent !== window;
  let nextId = 1;
  const pending = new Map();
  const handlers = {};
  const send = (message) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const text = (result) => (result.content || []).map((c) => c.text).filter(Boolean).join(" ");

  // Calls one of this server's tools through the host and returns its structuredContent.
  async function callTool(name, args) {
    const result = await request("tools/call", { name, arguments: args });
    if (result.isError) throw new Error(text(result) || "Something went wrong.");
    return result.structuredContent || {};
  }

  function connect(appInfo) {
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.id !== undefined && !message.method) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (waiter) message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
        return;
      }
      if (handlers[message.method]) handlers[message.method](message.params || {});
      if (message.id !== undefined) send({ id: message.id, result: {} });
    });

    const reportSize = () => send({
      method: "ui/notifications/size-changed",
      params: { height: Math.ceil(document.documentElement.getBoundingClientRect().height) },
    });
    new ResizeObserver(reportSize).observe(document.documentElement);

    return request("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo,
      appCapabilities: {},
    }).then((result) => {
      send({ method: "ui/notifications/initialized" });
      // The observer's first report can come before the host is listening; send one now too.
      reportSize();
      return result;
    });
  }

  return {
    embedded,
    request,
    callTool,
    text,
    connect,
    on: (method, handler) => (handlers[method] = handler),
  };
})();
`;

/**
 * Defines `cfpSite`, the site pages' counterpart to `mcpApp.callTool`: the same tool names,
 * arguments and results, sent to this site's API instead of through an agent. Profile and
 * talk calls use the signed-in session cookie; recording calls use the recording token.
 */
export const SITE_API_SCRIPT = `
const cfpSite = (() => {
  const ROUTES = {
    "save-profile": "/api/profile",
    "create-submission": "/api/submissions",
    "create-video-upload": "/api/recordings/upload",
    "attach-video": "/api/recordings/complete",
  };

  async function callTool(name, args) {
    const path = ROUTES[name];
    if (!path) throw new Error("Unknown action: " + name);
    const recording = name === "create-video-upload" || name === "attach-video";
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: recording
        ? { Authorization: "Bearer " + args.recording_token }
        : { "Content-Type": "application/json" },
      body: recording ? undefined : JSON.stringify(args),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Something went wrong. Please try again.");
    return body;
  }

  return { callTool };
})();
`;

/** Wraps an app's styles, markup and script into the document served as its UI resource. */
export const appDocument = (styles: string, markup: string, script: string) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://use.typekit.net/nln6hzq.css">
  <style>
    body { margin: 0; padding: 16px; background: #fffbeb; color: #020800; font-family: freight-sans-pro, sans-serif; font-size: 17px; font-weight: 300; }
    ${APP_STYLES}
    ${FORM_STYLES}
    ${styles}
  </style>
</head>
<body>
${markup}
<script>${APP_BRIDGE_SCRIPT}${script}</script>
</body>
</html>`;

/** UI resource metadata: fonts from the CascadiaJS Adobe Fonts kit, plus any extras. */
export const appResourceMeta = (extra: { connectDomains?: string[]; permissions?: object } = {}) => ({
  ui: {
    ...(extra.permissions ? { permissions: extra.permissions } : {}),
    csp: {
      ...(extra.connectDomains ? { connectDomains: extra.connectDomains } : {}),
      resourceDomains: ["https://use.typekit.net", "https://p.typekit.net"],
    },
    prefersBorder: true,
  },
});
