import { Hono } from "hono";
import { ConfidentialClientApplication, type Configuration } from "@azure/msal-node";
import { getUserByEmail, insertAuditLog } from "../db/database.js";
import { issueSession } from "../auth/session.js";
import { logger } from "../utils/logger.js";

const auth = new Hono();

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

function getAllowedDomains(): string[] {
  return (process.env.ENTRA_ALLOWED_DOMAINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Check if Entra is configured
auth.get("/status", (c) => {
  const client = getMsalClient();
  return c.json({ enabled: !!client });
});

// Start the OAuth login flow
auth.get("/login", async (c) => {
  cleanupStates();
  const client = getMsalClient();
  if (!client) return c.json({ error: "Entra SSO not configured" }, 500);

  const redirectUri = process.env.ENTRA_REDIRECT_URI || "http://localhost:3000/auth/callback";
  const state = crypto.randomUUID();
  stateStore.set(state, { createdAt: Date.now() });

  const url = await client.getAuthCodeUrl({
    scopes: ["openid", "profile", "email", "User.Read"],
    redirectUri,
    state,
  });

  return c.redirect(url);
});

// OAuth callback — exchange code, verify domain, match to local user
auth.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");
  const errorDescription = c.req.query("error_description");

  if (error) {
    return c.html(renderError("Microsoft login failed", errorDescription || error));
  }
  if (!code || !state) {
    return c.html(renderError("Missing authorization code", "The login response was incomplete."));
  }
  if (!stateStore.has(state)) {
    return c.html(renderError("Invalid login state", "Please try signing in again."));
  }
  stateStore.delete(state);

  const client = getMsalClient();
  if (!client) return c.html(renderError("SSO not configured", "Contact your administrator."));

  const redirectUri = process.env.ENTRA_REDIRECT_URI || "http://localhost:3000/auth/callback";

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

    if (!email) {
      return c.html(
        renderError("No email found", "Your Microsoft account did not provide an email."),
      );
    }

    // Domain check
    const domain = email.split("@")[1];
    const allowed = getAllowedDomains();
    if (allowed.length > 0 && !allowed.includes(domain || "")) {
      return c.html(
        renderError(
          "Access denied",
          `Only users from ${allowed.join(", ")} can sign in. Your email is ${email}.`,
        ),
      );
    }

    // Match to local user
    const user = getUserByEmail(email);
    if (!user) {
      return c.html(
        renderError(
          "Account not provisioned",
          `Your email (${email}) is not registered in this system. Please contact your administrator to add your account.`,
        ),
      );
    }
    if (!user.active) {
      return c.html(
        renderError("Account disabled", "Your account is disabled. Contact your administrator."),
      );
    }

    // Establish the server-side session (sets the httpOnly cookie).
    issueSession(c, { username: user.username, role: user.role });

    await insertAuditLog({
      staff_id: user.username,
      action: "sso_login",
      details: `Signed in via Entra ID (${email})`,
    });

    // Redirect to the app with username + role in URL fragment (not query — keeps it client-side)
    const params = new URLSearchParams({
      username: user.username,
      role: user.role,
      name: String(name),
    });
    return c.html(`<!DOCTYPE html><html><head><title>Signing in...</title></head><body>
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
    return c.html(renderError("Login failed", (err as Error).message));
  }
});

function renderError(title: string, message: string): string {
  return `<!DOCTYPE html><html><head><title>${title}</title>
<style>body{font-family:sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#333;}
.box{background:#fef2f2;border:1px solid #ef4444;border-radius:12px;padding:24px;}
h1{color:#991b1b;margin:0 0 12px;font-size:18px;}
p{font-size:14px;line-height:1.6;}
a{color:#1e368e;text-decoration:none;font-weight:600;}
a:hover{text-decoration:underline;}</style></head>
<body><div class="box">
<h1>&#9888; ${title}</h1>
<p>${message}</p>
<p><a href="/index.html">&larr; Back to login</a></p>
</div></body></html>`;
}

export default auth;
