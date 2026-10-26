import { createHash } from "node:crypto";
import { getDatabase } from "@netlify/database";
import { track } from "./analytics.js";
import { CfpError } from "./errors.js";
import { cancelUpload, createDirectUpload, deleteAsset, getAsset, getUpload, playerUrl, validVideo } from "./mux.js";

type Recording = {
  id: string;
  profile_id: string;
  mux_upload_id: string | null;
  upload_reserved_at: Date | null;
  video_submission_url: string | null;
  video_error: string | null;
  expired: boolean;
};

function tokenHash(token: string) {
  if (!/^rec_[A-Za-z0-9_-]{43}$/.test(token)) throw new CfpError(401, "Invalid recording link.");
  return createHash("sha256").update(token).digest("hex");
}

function globalLimit(name: string, fallback: number) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}

const unavailable = () => new CfpError(401, "This recording link is invalid or expired. Ask your agent to submit again, or contact info@cascadiajs.com.");

async function recordingForToken(token: string, email?: string): Promise<Recording> {
  const rows = await getDatabase().sql`
    SELECT s.*, s.recording_expires_at <= now() AS expired
    FROM public.submissions s JOIN public.profiles p ON p.id = s.profile_id
    WHERE s.recording_token_hash = ${tokenHash(token)} AND s.recording_expires_at > now()
      AND (${email ?? null}::text IS NULL OR lower(p.email_address) = lower(${email ?? null}))
  `;
  if (!rows[0]) throw unavailable();
  return rows[0] as Recording;
}

// Per-presenter upload quotas, across all of their submissions.
const USER_DAILY_LIMIT = 5;
const USER_TOTAL_LIMIT = 20;

/** Commit a single allocation, within both quotas, before calling the paid provider. */
async function reserveUpload(token: string, email?: string) {
  const hash = tokenHash(token);
  const dailyLimit = globalLimit("VIDEO_UPLOADS_DAILY_LIMIT", 100);
  const totalLimit = globalLimit("VIDEO_UPLOADS_TOTAL_LIMIT", 1000);
  const pool = getDatabase().pool;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '3s'");
    const { rows } = await client.query<Recording>(`
      SELECT s.* FROM public.submissions s JOIN public.profiles p ON p.id = s.profile_id
      WHERE s.recording_token_hash = $1 AND s.recording_expires_at > now()
        AND ($2::text IS NULL OR lower(p.email_address) = lower($2))
      FOR UPDATE OF s`, [hash, email ?? null]);
    const row = rows[0];
    if (!row) throw unavailable();
    if (row.video_error) throw new CfpError(422, row.video_error);
    if (row.video_submission_url) {
      await client.query("COMMIT");
      return row;
    }
    if (!row.upload_reserved_at) {
      // Quotas count reserved uploads in submissions. The lock serializes reservations so
      // concurrent calls can't both pass the count; it is released when this transaction ends.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('cfp:video-upload-reservations'))");
      const { rows: [usage] } = await client.query<{ global_today: number; global_total: number; user_today: number; user_total: number }>(`
        SELECT count(*) FILTER (WHERE today)::int AS global_today,
               count(*)::int AS global_total,
               count(*) FILTER (WHERE today AND profile_id = $1)::int AS user_today,
               count(*) FILTER (WHERE profile_id = $1)::int AS user_total
        FROM (
          SELECT profile_id,
                 upload_reserved_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS today
          FROM public.submissions WHERE upload_reserved_at IS NOT NULL
        ) reserved`, [row.profile_id]);
      if (usage.global_today >= dailyLimit || usage.global_total >= totalLimit ||
          usage.user_today >= USER_DAILY_LIMIT || usage.user_total >= USER_TOTAL_LIMIT) {
        throw new CfpError(429, "The recording upload limit has been reached. Use an existing video link or contact info@cascadiajs.com.");
      }
      await client.query("UPDATE public.submissions SET upload_reserved_at = now() WHERE id = $1", [row.id]);
    }
    await client.query("COMMIT");
    return row;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function createVideoUpload(token: string, email?: string) {
  const row = await reserveUpload(token, email);
  if (row.video_submission_url) return { uploaded: true };
  let upload;
  if (row.mux_upload_id) {
    upload = await getUpload(row.mux_upload_id);
  } else if (row.upload_reserved_at) {
    // Never retry a POST whose outcome is unknown: it could create a second billable asset.
    throw new CfpError(409, "The upload is being prepared or could not be prepared. Try again shortly; if this persists, contact info@cascadiajs.com.");
  } else {
    upload = await createDirectUpload(`submission:${row.id}`);
    // Persist before returning the upload capability. If persistence fails, no client
    // receives the URL; Mux expires the empty upload without creating an asset.
    await getDatabase().sql`UPDATE public.submissions SET mux_upload_id = ${upload.id} WHERE id = ${row.id}`;
  }
  if (upload.status === "asset_created") return { uploaded: true };
  if (upload.status !== "waiting") throw new CfpError(410, "This upload has expired or failed. Submit again or use an existing video link.");
  return { upload_url: upload.url, uploaded: false };
}

/** Also runs on a schedule, including when a browser disappears before completion. */
export async function processRecording(id: string) {
  const db = getDatabase();
  const rows = await db.sql`
    UPDATE public.submissions SET upload_check_until = now() + interval '30 seconds', upload_checked_at = now()
    WHERE id = ${id} AND video_submission_url IS NULL AND video_error IS NULL AND mux_upload_id IS NOT NULL
      AND (upload_check_until IS NULL OR upload_check_until < now())
      AND (upload_checked_at IS NULL OR upload_checked_at < now() - interval '3 seconds')
    RETURNING *, recording_expires_at <= now() AS expired
  `;
  const row = rows[0] as Recording | undefined;
  if (!row) return;
  try {
    const upload = await getUpload(row.mux_upload_id!);
    let error: string | null = null;
    let reason = "";
    if (row.expired) {
      if (upload.asset_id) await deleteAsset(upload.asset_id);
      else if (upload.status === "waiting") await cancelUpload(upload.id);
      error = "This recording expired before it was completed. Submit again or use an existing video link.";
      reason = "expired";
    } else if (["errored", "cancelled", "timed_out"].includes(upload.status)) {
      if (upload.asset_id) await deleteAsset(upload.asset_id);
      error = "The video upload failed or expired. Submit again or use an existing video link.";
      reason = "upload_failed";
    } else if (upload.asset_id) {
      const asset = await getAsset(upload.asset_id);
      if (asset?.status === "preparing") return;
      if (!asset || !validVideo(asset)) {
        if (asset) await deleteAsset(asset.id);
        error = "The recording must be a playable video of at most two minutes. Submit again or use an existing video link.";
        reason = "invalid_video";
      } else {
        const url = await playerUrl(asset);
        const attached = await db.sql`
          UPDATE public.submissions SET video_submission_url = ${url}
          WHERE id = ${id} AND video_submission_url IS NULL AND recording_expires_at > now()
          RETURNING id
        `;
        if (attached.length) await track("video_attached", row.profile_id, { submission_id: id, video: "recording" });
      }
    }
    if (error) {
      await db.sql`UPDATE public.submissions SET video_error = ${error} WHERE id = ${id}`;
      await track("video_failed", row.profile_id, { submission_id: id, reason });
    }
  } finally {
    await db.sql`UPDATE public.submissions SET upload_check_until = NULL WHERE id = ${id}`;
  }
}

export async function attachVideo(token: string, email?: string) {
  let row = await recordingForToken(token, email);
  if (!row.video_submission_url && !row.video_error) await processRecording(row.id);
  row = await recordingForToken(token, email);
  if (row.video_error) throw new CfpError(422, row.video_error);
  if (!row.video_submission_url) throw new CfpError(409, "The video is still processing. Please try again in a few seconds.");
  // Read-only completion retries are allowed until expiry; uploads remain single-use.
  return { submission_id: String(row.id), video_url: row.video_submission_url };
}
