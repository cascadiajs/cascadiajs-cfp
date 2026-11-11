import type { Config } from "@netlify/functions";
import { createHmac, timingSafeEqual } from "node:crypto";
import { processRecording, submissionForUpload } from "../lib/recordings.js";

// Mux webhook: Mux calls this when a recorded video is ready or its upload fails, and the
// video is then checked and attached (or its error recorded) as if the recorder had
// finished. It covers browsers that close before completing. Other events are ignored,
// without touching the database, so it can sleep between recordings.
//
// Signed with MUX_WEBHOOK_SECRET (Mux dashboard → Settings → Webhooks). Mux retries any
// non-2xx response for 24 hours, so "try again later" is a 503.

const EVENTS = new Set(["video.asset.ready", "video.asset.errored", "video.upload.errored", "video.upload.cancelled"]);
const TOLERANCE_SECONDS = 5 * 60;

/** Mux-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">. */
function verified(header: string | null, body: string, secret: string) {
  const parts = (header ?? "").split(",").map((part) => part.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  return signatures.some((signature) => {
    const actual = Buffer.from(signature ?? "", "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

type MuxEvent = {
  type?: string;
  data?: { id?: string; upload_id?: string; passthrough?: string; new_asset_settings?: { passthrough?: string } };
};

/** The submission id: from the passthrough set on the upload, else by the upload's id. */
async function submissionId(event: MuxEvent) {
  const data = event.data ?? {};
  const passthrough = data.passthrough ?? data.new_asset_settings?.passthrough;
  const match = passthrough?.match(/^submission:(\d+)$/);
  if (match) return match[1];
  const uploadId = event.type?.startsWith("video.upload.") ? data.id : data.upload_id;
  return uploadId ? submissionForUpload(uploadId) : undefined;
}

export default async (request: Request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = process.env.MUX_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.error("MUX_WEBHOOK_SECRET is not set; rejecting Mux webhook");
    return new Response("Webhook not configured", { status: 503 });
  }
  const body = await request.text();
  if (!verified(request.headers.get("mux-signature"), body, secret)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let event: MuxEvent;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!event.type || !EVENTS.has(event.type)) return new Response(null, { status: 204 });

  try {
    const id = await submissionId(event);
    // Uploads from another app or environment in the same Mux account.
    if (!id) return new Response(null, { status: 204 });
    const result = await processRecording(id);
    return new Response(null, { status: result === "retry" ? 503 : 204 });
  } catch (error) {
    console.error(`Mux webhook ${event.type} failed`, error);
    return new Response("Try again later", { status: 503 });
  }
};

export const config: Config = { path: "/webhooks/mux", method: "POST" };
