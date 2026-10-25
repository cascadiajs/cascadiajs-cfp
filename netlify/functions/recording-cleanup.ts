import type { Config } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { processRecording } from "../lib/recordings.js";

export default async () => {
  const db = getDatabase();
  const rows = await db.sql`
    SELECT id FROM public.submissions WHERE mux_upload_id IS NOT NULL
      AND video_submission_url IS NULL AND video_error IS NULL
      AND (upload_check_until IS NULL OR upload_check_until < now())
    ORDER BY upload_checked_at NULLS FIRST LIMIT 10
  `;
  const results = await Promise.allSettled(rows.map((row) => processRecording(String(row.id))));
  results.forEach((result, index) => {
    if (result.status === "rejected") console.error("Recording cleanup failed", rows[index].id);
  });
  await db.sql`UPDATE public.submissions SET recording_token_hash = NULL
    WHERE recording_expires_at <= now() AND recording_token_hash IS NOT NULL`;
  if (results.some((result) => result.status === "rejected")) throw new Error("Some recordings could not be cleaned up; the next run will retry.");
};

// Scheduled functions cannot be invoked through a public URL in production.
export const config: Config = { schedule: "*/5 * * * *" };
