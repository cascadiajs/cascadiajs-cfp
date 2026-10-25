import { createHash, randomBytes } from "node:crypto";
import { getDatabase } from "@netlify/database";
import { z } from "zod";
import { CfpError } from "./errors.js";
export { attachVideo, createVideoUpload } from "./recordings.js";

export { CfpError };

// The CFP itself. Callers identify the presenter by their verified email, which comes
// from the signed-in access token (see mcp.ts); this module never deals with sign-in.

const requiredText = (description: string) =>
  z.string().trim().min(1, "Required").describe(description);

// Require an absolute web URL; Zod's URL validator alone also accepts javascript:, data:, and file:.
const httpUrl = z.string().trim().url().refine(
  (value) => /^https?:\/\//i.test(value),
  "Use an absolute HTTP or HTTPS URL.",
);
const optionalUrl = (description: string) => httpUrl.optional().describe(`${description} (HTTP or HTTPS)`);

export const profileShape = {
  full_name: requiredText("Presenter's full name"),
  city: requiredText("City"),
  state: z.string().trim().min(1).optional().describe("State or province, if applicable"),
  country: requiredText("Country"),
  x_url: optionalUrl("X profile URL"),
  linkedin_url: optionalUrl("LinkedIn profile URL"),
  bluesky_url: optionalUrl("Bluesky profile URL"),
  other_url: optionalUrl("Any other social or personal URL"),
  referral: requiredText("How did you hear about our CFP?"),
  travel_covered: z.boolean().describe("Is your company able to cover your travel and lodging?"),
  confirmation: z
    .literal(true)
    .describe("Confirms availability to speak on June 7 or 8 in Seattle, WA"),
};

export const submissionShape = {
  talk_title: requiredText("Talk title (please, no colons)"),
  talk_description: requiredText("Talk description, fewer than 280 characters").pipe(
    z.string().max(279, "Must be fewer than 280 characters"),
  ),
  topics: requiredText("Comma-delimited list of technical topics covered"),
  video_submission_url: optionalUrl(
    "Publicly available video submission URL. Omit it to record the 2-minute video in the recorder instead.",
  ),
};

export const recordingShape = {
  recording_token: z.string().trim().min(1).describe("Recording token returned by submit-cfp"),
};

export const profileSchema = z.object(profileShape);

/** create-profile takes any subset; required details it lacks are collected in the profile form. */
export const partialProfileShape = profileSchema.partial().shape;
export const submissionSchema = z.object(submissionShape);

/** submit-cfp takes any subset; talk details it lacks are collected in the submission form. */
export const partialSubmissionShape = submissionSchema.partial().shape;

export type ProfileInput = z.infer<typeof profileSchema>;
export type SubmissionInput = z.infer<typeof submissionSchema>;

const PROFILE_FIELDS = Object.keys(profileShape) as (keyof ProfileInput)[];

const newSecret = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

type ProfileRow = { id: string | number; email_address: string; profile_completed_at: Date | null } & {
  [K in keyof ProfileInput]: ProfileInput[K] | null;
};

/** Returns the profile for a signed-in email, creating an empty one on first sign-in. */
export async function profileForEmail(email: string) {
  const rows = (await getDatabase().sql`
    INSERT INTO public.profiles (email_address) VALUES (${email})
    ON CONFLICT (lower(email_address)) DO UPDATE SET email_address = profiles.email_address
    RETURNING *
  `) as ProfileRow[];
  return rows[0];
}

/** The saved profile fields, without nulls, for pre-filling the profile form. */
export function savedProfile(profile: ProfileRow) {
  return Object.fromEntries(
    PROFILE_FIELDS.filter((field) => profile[field] !== null).map((field) => [field, profile[field]]),
  ) as Partial<ProfileInput>;
}

/** Saves the presenter's complete profile. Required before submitting a talk. */
export async function saveProfile(email: string, input: ProfileInput) {
  const profile = await profileForEmail(email);
  await getDatabase().sql`
    UPDATE public.profiles SET
      full_name = ${input.full_name}, city = ${input.city}, state = ${input.state ?? null},
      country = ${input.country}, x_url = ${input.x_url ?? null}, linkedin_url = ${input.linkedin_url ?? null},
      bluesky_url = ${input.bluesky_url ?? null}, other_url = ${input.other_url ?? null},
      referral = ${input.referral}, travel_covered = ${input.travel_covered}, confirmation = ${input.confirmation},
      profile_completed_at = coalesce(profile_completed_at, now())
    WHERE id = ${profile.id}
  `;
  return { profile_id: String(profile.id), email_address: profile.email_address };
}

/** Returns the presenter's profile, or throws if they haven't completed it with create-profile. */
export async function completedProfile(email: string) {
  const profile = await profileForEmail(email);
  if (!profile.profile_completed_at) {
    throw new CfpError(400, "Complete your CFP profile with create-profile before submitting a talk.");
  }
  return profile;
}

/**
 * Saves a talk proposal for the signed-in presenter. Without a video URL, the submission
 * waits for a recorded video and a recording token is returned for the recorder (MCP App
 * or /record page) to upload it.
 */
export async function submitCfp(email: string, input: SubmissionInput, origin: string) {
  const profile = await completedProfile(email);
  const db = getDatabase();

  const recordingToken = input.video_submission_url ? null : newSecret("rec");
  const rows = (await db.sql`
    INSERT INTO public.submissions (
      profile_id, talk_title, talk_description, topics, video_submission_url, recording_token_hash, recording_expires_at
    ) VALUES (
      ${profile.id}, ${input.talk_title}, ${input.talk_description},
      ${input.topics}, ${input.video_submission_url ?? null},
      ${recordingToken ? sha256(recordingToken) : null},
      CASE WHEN ${recordingToken !== null} THEN now() + interval '24 hours' END
    )
    RETURNING id, submitted_at
  `) as { id: string | number; submitted_at: string | Date }[];

  const { id, submitted_at } = rows[0];
  const result = { submission_id: String(id), submitted_at: new Date(submitted_at).toISOString() };
  if (!recordingToken) return { ...result, video_url: input.video_submission_url! };

  // The token goes in the fragment so it is never sent to a server or written to logs.
  const recordUrl = new URL("/record", origin);
  recordUrl.hash = `token=${recordingToken}`;
  return { ...result, recording_token: recordingToken, record_url: recordUrl.toString() };
}

/** Review decisions a submission can have; matches the CHECK on submissions.status. */
export const SUBMISSION_STATUSES = ["under_review", "accepted", "rejected", "waitlist"] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

type VideoStatus = "attached" | "processing" | "awaiting_recording" | "failed" | "missing";

/** The signed-in presenter's talk proposals, newest first, with where each video stands. */
export async function listSubmissions(email: string) {
  const rows = (await getDatabase().sql`
    SELECT s.id, s.submitted_at, s.talk_title, s.talk_description, s.topics, s.status, s.video_submission_url,
      s.video_error, s.mux_upload_id IS NOT NULL AS uploading, coalesce(s.recording_expires_at > now(), false) AS recording_open
    FROM public.submissions s JOIN public.profiles p ON p.id = s.profile_id
    WHERE lower(p.email_address) = lower(${email})
    ORDER BY s.submitted_at DESC, s.id DESC
  `) as {
    id: string | number;
    submitted_at: string | Date;
    talk_title: string;
    talk_description: string;
    topics: string;
    status: SubmissionStatus;
    video_submission_url: string | null;
    video_error: string | null;
    uploading: boolean;
    recording_open: boolean;
  }[];
  return rows.map((row) => {
    const video_status: VideoStatus = row.video_submission_url ? "attached"
      : row.video_error ? "failed"
      : row.recording_open ? (row.uploading ? "processing" : "awaiting_recording")
      : "missing";
    return {
      submission_id: String(row.id),
      submitted_at: new Date(row.submitted_at).toISOString(),
      talk_title: row.talk_title,
      talk_description: row.talk_description,
      topics: row.topics,
      status: row.status,
      video_status,
      ...(row.video_submission_url ? { video_url: row.video_submission_url } : {}),
      ...(row.video_error ? { video_error: row.video_error } : {}),
    };
  });
}
