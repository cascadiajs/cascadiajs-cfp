# Auth0 setup

The CFP's MCP server signs presenters in with Auth0. This guide sets up two Auth0 tenants:

- **Development:** used with `netlify dev` on `http://localhost:8888`.
- **Production:** used by `https://cfp.cascadiajs.com`.

Do every step once for each tenant, using the values in that tenant's column. Auth0's dashboard labels change from time to time; if a name doesn't match exactly, look for the closest equivalent.

## Values at a glance

| Setting | Development tenant | Production tenant |
| --- | --- | --- |
| Tenant name (your choice) | `cascadiajs-cfp-dev` | `cascadiajs-cfp` |
| API name | `CascadiaJS CFP MCP (dev)` | `CascadiaJS CFP MCP` |
| API identifier | `http://localhost:8888/mcp` | `https://cfp.cascadiajs.com/mcp` |
| API signing algorithm | `RS256` | `RS256` |
| Action name | `Add CFP email claim` | `Add CFP email claim` |
| Action claim name | `https://cfp.cascadiajs.com/email` | `https://cfp.cascadiajs.com/email` |
| Where `AUTH0_DOMAIN` goes | `.env.local` in this project | Netlify environment variables for the `cascadiajs-cfp` site |
| Dynamic Client Registration | On, for testing with agents and tools that lack CIMD support | Off unless an agent you need requires it |

Things to get exactly right:
- **API identifier:** type it exactly as shown, with no trailing slash. It can't be changed after the API is created. It must equal the URL agents connect to, which is why each environment needs its own.
- **Claim name:** it's the same in both tenants, `https://cfp.cascadiajs.com/email`, even in development. It's just a name, not a URL that gets called.

You can use a single tenant with both APIs instead. That works, but test sign-ins and test agents then appear alongside production ones, so two tenants are recommended.

## 1. Create the tenant

1. Sign in at [manage.auth0.com](https://manage.auth0.com).
2. Open the tenant menu (top left) and choose **Create tenant**.
3. Enter the tenant name from the table, pick a region, and create it. For production, mark the environment tag as **Production** if asked.

## 2. Find the tenant domain

You don't set the tenant domain; Auth0 assigns it, and you copy it into the app.

1. Go to **Applications → Applications** and open any application. Every tenant has a **Default App**.
2. On its **Settings** tab, copy the **Domain** field, for example `cascadiajs-cfp-dev.us.auth0.com`.

This is the `AUTH0_DOMAIN` value. Use just the domain: no `https://` and no trailing slash. If you later add a custom domain (step 9), use that instead.

## 3. Create the API

1. Go to **Applications → APIs → Create API**.
2. Fill in, using the values for this tenant:

   | Field | Development | Production |
   | --- | --- | --- |
   | Name | `CascadiaJS CFP MCP (dev)` | `CascadiaJS CFP MCP` |
   | Identifier | `http://localhost:8888/mcp` | `https://cfp.cascadiajs.com/mcp` |
   | JSON Web Token (JWT) Signing Algorithm | `RS256` | `RS256` |

3. Click **Create**.
4. On the API's **Settings** tab, set these the same way in both tenants:
   - **Allow Offline Access:** on, so agents get refresh tokens and presenters don't have to sign in again when a token expires.
   - **Token Expiration (Seconds):** leave the default or set `86400` (one day).
   - **JSON Web Token (JWT) Profile:** `RFC 9068` if offered (optional; the server accepts either profile).
   - **Enable RBAC:** off. Every presenter gets the same access.
5. Click **Save**.

## 4. Let self-registered agents use the API

Agents register themselves with Auth0, which makes each one a "third-party application". Auth0 has no per-app access setting for those, so access is granted here. Without this step, no agent can get a token.

1. On the same API's **Settings** tab, scroll to **Default Permissions for Third-Party Applications**.
2. Set **User-Delegated Access** to **Authorized**. The API has no custom permissions, so there are none to select.
3. Leave **Client Access** unauthorized.
4. Click **Save**.

Same in both tenants.

## 5. Turn on tenant settings

Go to **Settings** (left sidebar) → **Advanced**, scroll to the **Settings** section, and set:

| Setting | Development | Production | Why |
| --- | --- | --- | --- |
| Resource Parameter Compatibility Profile | On | On | Auth0 uses the `resource` value agents send as the token's audience |
| Include Issuer in Authorization Responses | On | On | Protects agents from mix-up attacks |
| Client ID Metadata Document Registration | On | On | Claude registers this way when Auth0 advertises it |
| Dynamic CIMD Registration | On | On | Lets agents register with their metadata document without an admin importing each one |
| Dynamic Client Registration | On | Off | Fallback for agents without CIMD support. It lets anyone create applications in the tenant, so keep it off in production unless you need it |

Click **Save**.

If **Dynamic CIMD Registration** can't be turned on (Auth0 returns "not entitled"), your plan may not include it. Then turn on **Dynamic Client Registration** in production too, and follow step 6.

## 6. Watch registrations (only where Dynamic Client Registration is on)

1. Go to **Monitoring → Logs** and search for:
   ```
   type:sapi AND description:"Dynamic client registration"
   ```
2. Check it occasionally. A sudden burst of registrations is the abuse Auth0 warns about. Delete unwanted apps under **Applications → Applications**.

## 7. Set up passwordless email sign-in

1. Go to **Authentication → Passwordless** and open **Email**.
2. Turn it on, then on its **Settings** tab:
   - **Authentication type:** **Code** (one-time password), not magic link;
   - **Code length:** `6`;
   - **Code expiry:** `600` seconds (10 minutes) is a good choice;
   - **From** and **Subject:** for example `CascadiaJS <cfp@cascadiajs.com>` and `Your CascadiaJS CFP sign-in code`. The defaults work for development.
3. Click **Save**.
4. **Promote the connection to domain level.** Self-registered agents can only use domain-level connections.
   - In the dashboard, turn on **Promote connection to domain level** on the email connection if you see it.
   - Otherwise use the [Auth0 CLI](https://auth0.com/docs/deploy-monitor/auth0-cli), logged in to this tenant. First list the connections:
     ```bash
     auth0 api get connections
     ```
     Copy the ID of the connection named `email` (it starts with `con_`), then:
     ```bash
     auth0 api patch connections/<CONNECTION_ID> --data '{"is_domain_connection": true}'
     ```
5. **Keep other sign-in methods off the agents' login page.** Don't promote the database or social connections to domain level. Only domain-level connections appear for agents.
6. **Set the login flow to ask for the email first.** Go to **Authentication → Authentication Profile**, select **Identifier First**, and click **Save**. With passwordless email as the only sign-in method, Auth0 needs this to know where to send the code. Without it, agents hit Auth0's "Oops, something went wrong" page, and the log says `no connections enabled for the client`, even though the connection is promoted.

Same in both tenants.

## 8. Add the email Action

The server identifies presenters by email, so Auth0 has to put it in the access token.

1. Go to **Actions → Library → Create Action → Build from scratch**.
2. Name it `Add CFP email claim`, choose the trigger **Login / Post Login**, and create it.
3. Replace the code with the contents of [`auth0/post-login-email-claim.js`](auth0/post-login-email-claim.js):
   ```js
   exports.onExecutePostLogin = async (event, api) => {
     if (event.user.email && event.user.email_verified) {
       api.accessToken.setCustomClaim("https://cfp.cascadiajs.com/email", event.user.email);
     }
   };
   ```
4. Click **Deploy**.
5. Go to **Actions → Triggers → post-login**. Drag **Add CFP email claim** into the flow between **Start** and **Complete**, then click **Apply**.

Same code and claim name in both tenants.

## 9. Branding (production; optional in development)

- **Custom domain:** **Branding → Custom Domains**, for example `auth.cascadiajs.com`, so presenters see your domain instead of `auth0.com`. Once it's verified, use it as `AUTH0_DOMAIN` instead of the tenant domain.
- **Login page:** **Branding → Universal Login**, with the CascadiaJS logo and colors: navy `#112378`, emerald `#17c37b`, cream `#fffbeb`.
- **Email provider:** **Branding → Email Provider**. Auth0's built-in provider is rate-limited and meant for testing, so set up your own provider for production.
- **Email template:** **Branding → Email Templates → Verification Code (for Passwordless)**, with CascadiaJS wording.

## 10. Connect the app

**Development:**
1. Add the development tenant domain from step 2 to `.env.local` in this project:
   ```
   AUTH0_DOMAIN=cascadiajs-cfp-dev.us.auth0.com
   ```
2. Restart the dev server:
   ```bash
   npm run dev
   ```
3. Check that the server sends agents to your tenant:
   ```bash
   curl http://localhost:8888/.well-known/oauth-protected-resource/mcp
   ```
   `authorization_servers` should be `["https://cascadiajs-cfp-dev.us.auth0.com/"]` (with your domain).

**Production:**
1. In Netlify, open the `cascadiajs-cfp` site and go to **Site configuration → Environment variables**.
2. Add `AUTH0_DOMAIN` with the production tenant domain from step 2 (or your custom domain).
3. Deploy, then check:
   ```bash
   curl https://cfp.cascadiajs.com/.well-known/oauth-protected-resource/mcp
   ```
   `authorization_servers` should be `["https://<production tenant domain>/"]`.

**Both:** check that Auth0 advertises a registration method agents can use:
```bash
curl https://<tenant domain>/.well-known/openid-configuration
```
Look for `"client_id_metadata_document_supported": true` with `"none"` in `token_endpoint_auth_methods_supported` (what Claude needs for CIMD), or a `registration_endpoint` where Dynamic Client Registration is on.

## 11. Test a sign-in

1. In your agent, add (or reconnect) the MCP server:

   | | Development | Production |
   | --- | --- | --- |
   | MCP server URL | `http://localhost:8888/mcp` | `https://cfp.cascadiajs.com/mcp` |

2. The agent opens Auth0's login page. Enter your email, then the code Auth0 sends.
3. Approve the consent screen for the agent. Every self-registered agent is a third-party app, so presenters see this the first time they connect.
4. Ask: "Help me submit a talk to the CascadiaJS 2027 CFP". The profile form should appear.

In development, the dev server logs one `[mcp]` line per request with the signed-in email, which helps when something doesn't work.

Agents that run in the cloud, like Claude on the web, may not be able to reach `localhost`. If so, test development with an agent on your machine, such as Claude Code or Claude Desktop.

## Troubleshooting

| What you see | Likely cause | Fix |
| --- | --- | --- |
| Auth0 error about an invalid or unknown audience | The API identifier doesn't exactly match the MCP server URL, or the compatibility profile is off | Steps 3 and 5 |
| Auth0 error saying the client isn't authorized for the API | Third-party access isn't granted | Step 4 |
| Auth0's "Oops, something went wrong" page; the log says `no connections enabled for the client` | The email connection isn't promoted to domain level, or the authentication profile isn't Identifier First | Steps 7.4 and 7.6 |
| Sign-in succeeds but the agent still gets errors (401) | The token has no email: the Action isn't deployed or isn't in the post-login flow | Step 8 |
| The agent can't register | Neither CIMD nor Dynamic Client Registration is on | Step 5 |
| `/mcp` answers "Sign-in isn't configured on this server" | `AUTH0_DOMAIN` isn't set | Step 10 |
| Works locally but not in production | The production tenant is missing a step, or Netlify's `AUTH0_DOMAIN` points at the development tenant | Repeat the steps for production; check step 10 |
