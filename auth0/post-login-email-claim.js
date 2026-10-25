// Auth0 post-login Action: adds the presenter's verified email to the access token, under
// the claim the MCP server reads (EMAIL_CLAIM in netlify/lib/auth/config.ts).
//
// Paste this into Auth0: Actions > Library > Create Action > Build from scratch
// (trigger "Login / Post Login"), deploy it, then add it to the Login flow.

exports.onExecutePostLogin = async (event, api) => {
  if (event.user.email && event.user.email_verified) {
    api.accessToken.setCustomClaim("https://cfp.cascadiajs.com/email", event.user.email);
  }
};
