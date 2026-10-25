import type { Config } from "@netlify/functions";
import { APP_STYLES } from "../lib/app.js";
import { sitePage } from "../lib/page.js";
import { RECORDER_MARKUP, RECORDER_SCRIPT, RECORDER_STYLES } from "../lib/recorder.js";

// Fallback recorder for agents that can't show the submit-cfp MCP App or that block the
// camera. submit-cfp returns a link here with the recording token in the fragment.

export default async () =>
  sitePage({
    status: 200,
    title: "Record your video",
    head: `<style>${APP_STYLES}${RECORDER_STYLES}</style>`,
    body: RECORDER_MARKUP,
    script: RECORDER_SCRIPT,
  });

export const config: Config = { path: "/record", method: "GET" };
