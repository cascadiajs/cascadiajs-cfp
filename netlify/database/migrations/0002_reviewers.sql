-- Who can open /review: organizers and the reviewers they invite. Access is checked
-- against this table on every request, so deleting a row revokes access at once.

-- Emails are stored lowercased, so the primary key also stops case-only duplicates.
CREATE TABLE public.reviewers (
  email text PRIMARY KEY CHECK (email = lower(btrim(email)) AND email <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  role text NOT NULL DEFAULT 'reviewer' CHECK (role IN ('admin', 'reviewer')),
  accepted timestamptz
);

COMMENT ON TABLE public.reviewers IS
  'Allow-list for /review. Admins invite reviewers and can remove them; both can read submissions.';
COMMENT ON COLUMN public.reviewers.role IS 'admin: also manages the reviewer list. reviewer: reads submissions.';
COMMENT ON COLUMN public.reviewers.accepted IS
  'When the person first signed in to /review with this email. Null while the invitation is pending.';

INSERT INTO public.reviewers (email, name, role)
VALUES ('carter@cascadiajs.com', 'Carter Rabasa', 'admin');
