import { CfpError } from "./errors.js";

export const UPLOAD_URL_SECONDS = 900;
// Tolerance for MediaRecorder/browser timer delays.
export const MAX_VIDEO_SECONDS = 125;
export type MuxUpload = { id: string; url: string; status: string; asset_id?: string };
export type MuxAsset = {
  id: string;
  status: string;
  duration?: number;
  tracks?: { type: string }[];
  playback_ids?: { id: string; policy: string }[];
};

async function mux<T>(method: string, path: string, body?: unknown, missingIsNull = false): Promise<T> {
  const id = process.env.MUX_TOKEN_ID;
  const secret = process.env.MUX_TOKEN_SECRET;
  if (!id || !secret) throw new Error("MUX_TOKEN_ID and MUX_TOKEN_SECRET must be set");
  const response = await fetch(`https://api.mux.com${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (method === "DELETE" && response.status === 404) return undefined as T;
  if (missingIsNull && response.status === 404) return null as T;
  if (!response.ok) {
    console.error("Mux request failed", method, path, response.status);
    throw new CfpError(502, "The video service is unavailable. Please try again later.");
  }
  if (response.status === 204) return undefined as T;
  return ((await response.json()) as { data: T }).data;
}

export function createDirectUpload(passthrough: string) {
  return mux<MuxUpload>("POST", "/video/v1/uploads", {
    cors_origin: "*", // MCP app iframe origins vary by host.
    timeout: UPLOAD_URL_SECONDS,
    new_asset_settings: {
      // No playback ID until the server validates the processed media.
      video_quality: "basic",
      max_resolution_tier: "1080p",
      passthrough,
    },
  });
}

export const getUpload = (id: string) => mux<MuxUpload>("GET", `/video/v1/uploads/${encodeURIComponent(id)}`);
export const getAsset = (id: string) => mux<MuxAsset | null>("GET", `/video/v1/assets/${encodeURIComponent(id)}`, undefined, true);
export const deleteAsset = (id: string) => mux<void>("DELETE", `/video/v1/assets/${encodeURIComponent(id)}`);
export const cancelUpload = (id: string) => mux<MuxUpload>("PUT", `/video/v1/uploads/${encodeURIComponent(id)}/cancel`);

export function validVideo(asset: MuxAsset) {
  return asset.status === "ready" && typeof asset.duration === "number" &&
    Number.isFinite(asset.duration) && asset.duration > 0 && asset.duration <= MAX_VIDEO_SECONDS &&
    asset.tracks?.some((track) => track.type === "video") === true;
}

export async function playerUrl(asset: MuxAsset) {
  const playback = asset.playback_ids?.find((item) => item.policy === "public") ??
    await mux<{ id: string }>("POST", `/video/v1/assets/${encodeURIComponent(asset.id)}/playback-ids`, { policy: "public" });
  return `https://player.mux.com/${playback.id}`;
}
