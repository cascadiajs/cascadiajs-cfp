-- CascadiaJS 2027 Call for Presenters. A presenter signs in with their email through
-- Auth0, completes their profile (create-profile), then sends one submission per talk (submit-cfp).

-- Presenters are keyed by verified email, not by Auth0 user id, so changing how people
-- sign in never orphans a profile or its submissions. A row is created on
-- first sign-in; the profile fields stay null until create-profile completes them.
CREATE TABLE public.profiles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  email_address text NOT NULL CHECK (btrim(email_address) <> ''),
  full_name text CHECK (btrim(full_name) <> ''),
  city text CHECK (btrim(city) <> ''),
  state text,
  country text CHECK (btrim(country) <> ''),
  x_url text,
  linkedin_url text,
  bluesky_url text,
  other_url text,
  referral text CHECK (btrim(referral) <> ''),
  travel_covered boolean,
  confirmation boolean CHECK (confirmation = true),
  profile_completed_at timestamptz,
  CHECK (
    profile_completed_at IS NULL OR (
      full_name IS NOT NULL AND city IS NOT NULL AND country IS NOT NULL AND
      referral IS NOT NULL AND travel_covered IS NOT NULL AND confirmation IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX profiles_email_address_key ON public.profiles (lower(email_address));

COMMENT ON TABLE public.profiles IS
  'CascadiaJS 2027 CFP presenter profiles, one row per verified email address.';
COMMENT ON COLUMN public.profiles.referral IS 'How did you hear about our CFP?';
COMMENT ON COLUMN public.profiles.travel_covered IS
  'Is your company able to cover your travel and lodging? Yes = true; No = false.';
COMMENT ON COLUMN public.profiles.confirmation IS
  'Confirmation of availability to speak on either June 7 or 8 in Seattle, WA. I confirm = true.';
COMMENT ON COLUMN public.profiles.profile_completed_at IS
  'When create-profile saved the required profile fields. submit-cfp is refused until then.';

CREATE TABLE public.submissions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  profile_id bigint NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  talk_title text NOT NULL CHECK (btrim(talk_title) <> ''),
  talk_description text NOT NULL
    CHECK (btrim(talk_description) <> '' AND char_length(talk_description) < 280),
  topics text NOT NULL CHECK (btrim(topics) <> ''),
  status text NOT NULL DEFAULT 'under_review'
    CHECK (status IN ('under_review', 'accepted', 'rejected', 'waitlist')),
  -- Null until a video is attached: either passed with submit-cfp or recorded
  -- in the recorder, which uploads to Mux and fills this with a player URL.
  video_submission_url text CHECK (btrim(video_submission_url) <> ''),
  recording_token_hash text UNIQUE,
  mux_upload_id text,
  recording_expires_at timestamptz,
  upload_reserved_at timestamptz,
  upload_checked_at timestamptz,
  upload_check_until timestamptz,
  video_error text
);

CREATE INDEX submissions_profile_id_idx ON public.submissions (profile_id);
CREATE INDEX submissions_pending_upload_idx ON public.submissions
  (upload_checked_at NULLS FIRST) WHERE mux_upload_id IS NOT NULL
  AND video_submission_url IS NULL AND video_error IS NULL;

COMMENT ON TABLE public.submissions IS
  'CascadiaJS 2027 Call for Presenters talk proposals; one row per talk, many per profile.';
COMMENT ON COLUMN public.submissions.talk_title IS 'Talk Title. Form guidance: please, no colons.';
COMMENT ON COLUMN public.submissions.talk_description IS 'Talk Description: fewer than 280 characters.';
COMMENT ON COLUMN public.submissions.topics IS 'Topic(s): comma-delimited list of technical topics being covered.';
COMMENT ON COLUMN public.submissions.status IS
  'Review decision: under_review until the organizers set accepted, rejected or waitlist.';
COMMENT ON COLUMN public.submissions.video_submission_url IS
  'Video submission URL: must be publicly available. Null while the video is still to be recorded.';
COMMENT ON COLUMN public.submissions.recording_token_hash IS
  'SHA-256 digest of the scoped recording token. After completion, permits only completion retries until expiry.';
COMMENT ON COLUMN public.submissions.mux_upload_id IS 'Mux direct upload id for a recorded video.';
COMMENT ON COLUMN public.submissions.upload_reserved_at IS
  'Durable allocation made before contacting Mux. Never cleared automatically, including on ambiguous failures. Upload quotas count these.';
