import { PostHog } from "posthog-node";

// PostHog analytics (US Cloud). Off unless POSTHOG_KEY is set, so local development and
// deploy previews send nothing. The browser side (pageviews on the site's pages) is served
// by netlify/functions/analytics.ts; server-side CFP events are sent with track().

export const POSTHOG_HOST = "https://us.i.posthog.com";
/**
 * PostHog's managed reverse proxy, used by the browser so ad blockers don't drop page
 * events. Server-side events go straight to POSTHOG_HOST: blockers don't see them.
 */
export const POSTHOG_PROXY_HOST = "https://g.cascadiajs.com";
/** The PostHog app itself, for links such as the toolbar's when api_host is the proxy. */
export const POSTHOG_UI_HOST = "https://us.posthog.com";

/** The PostHog project API key. It is public by design: the browser snippet sends it too. */
export const posthogKey = () => process.env.POSTHOG_KEY?.trim() || undefined;

let client: PostHog | undefined;

/**
 * Sends a server-side CFP event for a presenter, identified only by their profile id: no
 * email, no person profile and no IP-based location (the IP is Netlify's, not theirs).
 * Sent before returning because a function can end as soon as it responds. Never throws.
 */
export async function track(event: string, profileId: string | number, properties: Record<string, unknown> = {}) {
  const key = posthogKey();
  if (!key) return;
  client ??= new PostHog(key, { host: POSTHOG_HOST, flushAt: 1, flushInterval: 0, requestTimeout: 3000, fetchRetryCount: 0 });
  try {
    await client.captureImmediate({
      distinctId: `profile_${profileId}`,
      event,
      properties: { ...properties, $process_person_profile: false },
      disableGeoip: true,
    });
  } catch (error) {
    console.error(`PostHog capture failed for ${event}`, error);
  }
}
