import type { Config } from "@netlify/functions";
import { POSTHOG_HOST, posthogKey } from "../lib/analytics.js";

// /analytics.js: PostHog web analytics for the site's pages (public/index.html and the
// server-rendered pages in netlify/lib/page.ts), served from here so the key comes from
// POSTHOG_KEY. Without it, the script is empty. The MCP App forms shown inside agents
// don't load it.

// PostHog's loader snippet, from https://posthog.com/docs/libraries/js.
const SNIPPET = `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],Object.defineProperty(u,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e}}),Object.defineProperty(u.people,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(){return u.toString(1)+".people (stub)"}}),o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);`;

const script = (key: string) => `${SNIPPET}
posthog.init(${JSON.stringify(key)}, {
  api_host: ${JSON.stringify(POSTHOG_HOST)},
  defaults: "2026-08-30",
  // No cookies or browser storage; PostHog counts visitors with a server-side hash.
  // Also needs cookieless mode turned on in the PostHog project settings.
  cookieless_mode: "always",
  disable_session_recording: true,
  // The /record page carries its recording token in the URL fragment: never send fragments.
  before_send: function (event) {
    var props = event && event.properties;
    if (props) {
      for (var name in props) {
        if (typeof props[name] === "string" && /^https?:\\/\\/[^#]*#/.test(props[name])) props[name] = props[name].split("#")[0];
      }
    }
    return event;
  },
});
`;

export default async () => {
  const key = posthogKey();
  return new Response(key ? script(key) : "// Analytics is off: POSTHOG_KEY isn't set.\n", {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
};

export const config: Config = { path: "/analytics.js" };
