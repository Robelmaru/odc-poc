import type { FastifyInstance, FastifyRequest } from "fastify";
import { ConfidentialClientApplication, type Configuration } from "@azure/msal-node";
import { getUserByEmail, insertAuditLog } from "../db/database.js";
import { issueSession } from "../auth/session.js";
import { logger } from "../utils/logger.js";

// In-memory state store (for OAuth state param verification)
const stateStore = new Map<string, { createdAt: number }>();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 min

function cleanupStates() {
  const now = Date.now();
  for (const [k, v] of stateStore.entries()) {
    if (now - v.createdAt > STATE_TTL_MS) stateStore.delete(k);
  }
}

function getMsalClient(): ConfidentialClientApplication | null {
  const clientId = process.env.ENTRA_CLIENT_ID;
  const tenantId = process.env.ENTRA_TENANT_ID;
  const clientSecret = process.env.ENTRA_CLIENT_SECRET;
  if (!clientId || !tenantId || !clientSecret || clientSecret === "YOUR_SECRET_HERE") {
    return null;
  }
  const config: Configuration = {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      clientSecret,
    },
  };
  return new ConfidentialClientApplication(config);
}

// Resolve the OAuth redirect URI from the *actual request host* rather than a
// single static env var. Each environment (dev-tim / staging / prod) is reached
// on its own hostname through the same image, so a hard-coded ENTRA_REDIRECT_URI
// is a per-environment footgun: a secret copied from staging sends dev-tim users
// to staging's /auth/callback (the state won't exist there → "Invalid login
// state", and they never land back on dev-tim). Deriving it here keeps /login and
// /callback in lock-step on whatever host the user actually came in on.
//
// This is not an open-redirect risk: Microsoft only honors redirect URIs that are
// pre-registered on the app registration, so a spoofed Host just fails at the IdP
// with AADSTS50011. ENTRA_REDIRECT_URI is kept as an explicit override / fallback
// for when no host can be determined.
function resolveRedirectUri(request: FastifyRequest): string {
  const firstHeader = (name: string): string | undefined =>
    (request.headers[name] as string | undefined)?.split(",")[0]?.trim();
  // Behind the nginx ingress the original Host is preserved and X-Forwarded-Proto
  // is set to https (TLS terminates at the edge); on localhost neither is present,
  // so request.protocol ("http") and the Host header give the right local URL.
  const host = firstHeader("x-forwarded-host") || request.headers.host;
  const proto = firstHeader("x-forwarded-proto") || request.protocol;
  if (host) return `${proto}://${host}/auth/callback`;
  return process.env.ENTRA_REDIRECT_URI || "http://localhost:3000/auth/callback";
}

function getAllowedDomains(): string[] {
  return (process.env.ENTRA_ALLOWED_DOMAINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

function renderError(title: string, message: string): string {
  // HTML-escape interpolated values (SEC-001/SEC-009).
  return `<!DOCTYPE html><html><head><title>${esc(title)}</title>
<style>body{font-family:sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#333;}
.box{background:#fef2f2;border:1px solid #ef4444;border-radius:12px;padding:24px;}
h1{color:#991b1b;margin:0 0 12px;font-size:18px;}
p{font-size:14px;line-height:1.6;}
a{color:#1e368e;text-decoration:none;font-weight:600;}
a:hover{text-decoration:underline;}</style></head>
<body><div class="box">
<h1>&#9888; ${esc(title)}</h1>
<p>${esc(message)}</p>
<p><a href="/index.html">&larr; Back to login</a></p>
</div></body></html>`;
}

export default async function auth(app: FastifyInstance) {
  // Is Entra configured?
  app.get("/status", { schema: { tags: ["auth"] } }, async () => {
    return { enabled: !!getMsalClient() };
  });

  // Start the OAuth login flow
  app.get("/login", { schema: { tags: ["auth"] } }, async (request, reply) => {
    cleanupStates();
    const client = getMsalClient();
    if (!client) return reply.code(500).send({ error: "Entra SSO not configured" });

    const redirectUri = resolveRedirectUri(request);
    const state = crypto.randomUUID();
    stateStore.set(state, { createdAt: Date.now() });

    const url = await client.getAuthCodeUrl({
      scopes: ["openid", "profile", "email", "User.Read"],
      redirectUri,
      state,
    });
    return reply.redirect(url);
  });

  // OAuth callback — exchange code, verify domain, match to local user
  app.get("/callback", { schema: { tags: ["auth"] } }, async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const { code, state, error, error_description: errorDescription } = q;
    const html = (s: string) => reply.type("text/html").send(s);

    if (error) return html(renderError("Microsoft login failed", errorDescription || error));
    if (!code || !state)
      return html(renderError("Missing authorization code", "The login response was incomplete."));
    if (!stateStore.has(state))
      return html(renderError("Invalid login state", "Please try signing in again."));
    stateStore.delete(state);

    const client = getMsalClient();
    if (!client) return html(renderError("SSO not configured", "Contact your administrator."));

    // Must match the redirect_uri used in /login — both derive from the same host.
    const redirectUri = resolveRedirectUri(request);

    try {
      const tokenResponse = await client.acquireTokenByCode({
        code,
        scopes: ["openid", "profile", "email", "User.Read"],
        redirectUri,
      });

      const account = tokenResponse.account;
      const claims = tokenResponse.idTokenClaims as
        | { preferred_username?: string; name?: string }
        | undefined;
      const email = (account?.username || claims?.preferred_username || "").toLowerCase();
      const name = account?.name || claims?.name || email;

      if (!email)
        return html(
          renderError("No email found", "Your Microsoft account did not provide an email."),
        );

      const domain = email.split("@")[1];
      const allowed = getAllowedDomains();
      if (allowed.length > 0 && !allowed.includes(domain || "")) {
        return html(
          renderError("Access denied", `Only users from ${allowed.join(", ")} can sign in.`),
        );
      }

      const user = await getUserByEmail(email);
      if (!user)
        return html(
          renderError(
            "Account not provisioned",
            `Your email (${email}) is not registered in this system. Please contact your administrator.`,
          ),
        );
      if (!user.active)
        return html(
          renderError("Account disabled", "Your account is disabled. Contact your administrator."),
        );

      // Establish the server-side session (sets the httpOnly cookie).
      await issueSession(reply, { username: user.username, role: user.role });

      await insertAuditLog({
        staff_id: user.username,
        action: "sso_login",
        details: `Signed in via Entra ID (${email})`,
      });

      return html(`<!DOCTYPE html><html><head><title>Signing in...</title></head><body>
<script>
  sessionStorage.setItem('loggedInStaff', ${JSON.stringify(user.username)});
  sessionStorage.setItem('loggedInRole', ${JSON.stringify(user.role)});
  sessionStorage.setItem('loggedInDisplayName', ${JSON.stringify(name)});
  window.location.href = '/index.html';
</script>
<p style="font-family:sans-serif;text-align:center;margin-top:40px;">Signing you in&hellip;</p>
</body></html>`);
    } catch (err) {
      logger.error("Auth callback error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return html(renderError("Login failed", "An unexpected error occurred. Please try again."));
    }
  });
}
