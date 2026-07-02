# Clerk auth + billing on Cloudflare Workers + Durable Objects

A reusable integration playbook: social sign-in + a Pro subscription gate, enforced
in a Cloudflare Worker, with **no database and no Stripe webhook** to run. Written
from the `podrecorder.net` implementation but framed so you can lift it into another
Cloudflare + Durable-Objects site.

---

## The model in one paragraph

The **client** loads Clerk's JS, signs the user in (social logins), and on gated
requests attaches the Clerk **session JWT** as `Authorization: Bearer …`. The
**Worker** verifies that JWT with `@clerk/backend` and checks entitlement with
`auth.has({ plan: 'pro' })`. Billing is **Clerk Billing** (Stripe under the hood):
you connect your Stripe account to Clerk once, define plans in the Clerk dashboard,
and the entitlement rides in the verified session — so the app needs **no webhook,
no `customer` table, no Stripe SDK**. A single `AUTH_MODE` flag (`off` / `prelaunch`
/ `live`) controls whether the auth UI shows and whether sign-in alone or a paid plan
grants access.

```
Browser                                  Cloudflare Worker
────────                                  ─────────────────
@clerk/clerk-js  ──sign in (social)──►    (Clerk hosted)
   │  session JWT
   ├── GET /api/config ───────────────►   { authMode }         (what UI to show)
   └── gated request + Bearer <JWT> ──►   @clerk/backend:
                                            authenticateRequest()
                                            auth.has({ plan:'pro' })
                                          → allow / deny the gated resource
Billing: Clerk Billing → Stripe   (entitlement is in the session; no webhook/DB)
```

---

## Dependencies

- **Server (Worker):** `@clerk/backend` — an npm dep; it bundles and runs in the
  Workers V8 isolate. `npm i @clerk/backend`.
- **Client:** `@clerk/clerk-js` loaded from the Clerk CDN via a `<script>` tag — no
  build step, no bundler.

---

## 1. Clerk dashboard setup (one-time)

1. Create a Clerk **application**.
2. **Social connections:** enable Google / Microsoft / Facebook, etc. In a
   **development** instance Clerk supplies shared OAuth credentials, so they work
   immediately. **Apple** typically needs your own Apple Developer account even in
   dev. For **production** you must supply your own OAuth credentials per provider.
3. **Billing:** enable it, then create a **plan** with the slug you'll check for
   (this guide uses `pro`). A dev instance uses the **Clerk development gateway** (a
   shared test Stripe) so you can test with test cards and no Stripe account;
   **production** requires connecting **your own Stripe account** (live mode).
4. Copy three values: **publishable key** (`pk_test_…`/`pk_live_…`), the **Frontend
   API host** (`<slug>.clerk.accounts.dev` — it's base64-encoded inside the
   publishable key), and the **secret key** (`sk_test_…`/`sk_live_…`).

> **Plans live in Clerk, not Stripe.** You create the plan/price in the Clerk
> dashboard; Clerk uses Stripe only for processing. Don't create the product in
> Stripe.

---

## 2. Config & secrets

**Worker secrets** (`wrangler secret put …`, or `.dev.vars` for local):

| Name | Purpose | Notes |
|---|---|---|
| `CLERK_SECRET_KEY` | verify JWTs server-side | secret |
| `CLERK_PUBLISHABLE_KEY` | passed to `createClerkClient` | public, kept with the pair |
| `AUTH_MODE` | `off` \| `prelaunch` \| `live` | see §5 |
| `TEST_ENTITLE_SECRET` | CI/dev bypass | **never set in prod** |

**Client:** the **publishable key** and **Frontend API host** are inlined in the HTML
(they're public by design — the key is shipped in every client bundle):

```html
<script
  async crossorigin="anonymous"
  data-clerk-publishable-key="pk_test_XXXX"
  src="https://YOUR-slug.clerk.accounts.dev/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
></script>
```

---

## 3. Server side (Worker)

`@clerk/backend` verifies the incoming request's session and exposes `has()` for
billing checks. Entitlement resolution, honoring `AUTH_MODE`:

```js
import { createClerkClient } from '@clerk/backend';

// Returns a userId when the caller is entitled, else null.
async function requirePro(request, env) {
  // CI/dev bypass — only honored when the secret is set (never in prod).
  const testHeader = request.headers.get('X-Test-Entitle');
  if (env.TEST_ENTITLE_SECRET && testHeader === env.TEST_ENTITLE_SECRET) return 'test-user';

  const mode = env.AUTH_MODE || 'off';
  if (mode === 'off' || !env.CLERK_SECRET_KEY) return null;
  try {
    const clerk = createClerkClient({
      secretKey: env.CLERK_SECRET_KEY,
      publishableKey: env.CLERK_PUBLISHABLE_KEY,
    });
    const auth = (await clerk.authenticateRequest(request)).toAuth();
    if (!auth?.userId) return null;
    if (mode === 'prelaunch') return auth.userId;                 // signed-in = entitled
    if (mode === 'live' && auth.has({ plan: 'pro' })) return auth.userId; // paid plan
    return null;
  } catch {
    return null;
  }
}
```

Expose the mode so the client knows what UI to render:

```js
if (pathname === '/api/config') {
  return Response.json({ authMode: env.AUTH_MODE || 'off' });
}
```

Then **gate your cost-incurring endpoints** on `requirePro`. In this project, an
entitled caller flips a per-room Durable Object to `entitled=true` and the guest
inherits it; gated endpoints (`/api/turn-credentials`, `/api/blob/*`) consult that
flag. **Generalize it to your app:** call `requirePro(request, env)`, and on a
non-null result grant the paid resource; on `null` return `402` (or degrade). The
important part is that enforcement is **server-side** — the client UI (below) is only
cosmetic.

> **DO note:** don't make a DO→DO `fetch` from inside a WebSocket-**upgrade** handler;
> it fails with "Network connection lost." Do the auth/entitlement work in the plain
> Worker request context (before you return the 101), or in a separate endpoint.

---

## 4. Client side

Load Clerk (see §2 script tag), then a small controller:

```js
let authMode = 'off';

async function initClerk() {
  // Only show auth UI when the Worker says so; 'off' → stay anonymous/free.
  try { authMode = (await (await fetch('/api/config')).json()).authMode || 'off'; }
  catch { authMode = 'off'; }
  if (authMode === 'off') return;

  const clerk = await waitForClerk();   // poll for window.Clerk (loader may be absent)
  if (!clerk) return;
  await clerk.load();

  document.getElementById('btnSignIn').onclick = () => clerk.openSignIn({ afterSignInUrl: location.href });
  document.getElementById('btnGoPro').onclick  = () => clerk.openUserProfile();  // native billing modal
  renderClerk(clerk);
  clerk.addListener(() => renderClerk(clerk));

  // Entitlement lives in the session token's claims, which LAG a billing change.
  // Refresh the token + re-render on tab focus / a short interval / modal close, so
  // the plan badge self-heals without a manual reload.
  const refresh = async () => {
    if (clerk.user) { try { await clerk.session?.getToken({ skipCache: true }); } catch {} }
    renderClerk(clerk);
  };
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(refresh, 30000);
  // Fire the instant the account/checkout modal closes (Clerk exposes no close event):
  let open = false;
  new MutationObserver(() => {
    const now = !!document.querySelector('[class*="cl-modal"]');
    if (open && !now) refresh();
    open = now;
  }).observe(document.body, { childList: true, subtree: true });
}

function hasPro(clerk) {           // UI only — the server is authoritative
  try { return !!clerk.session?.checkAuthorization?.({ plan: 'pro' }); } catch { return false; }
}
```

Attach the JWT on gated requests:

```js
const headers = {};
if (clerk.session) headers.Authorization = `Bearer ${await clerk.session.getToken()}`;
await fetch('/api/whatever', { method: 'POST', headers });
```

**"Go Pro" / checkout:** use Clerk's **own** modal (`clerk.openUserProfile()` → Billing)
or a **dedicated pricing page** rendering `clerk.mountPricingTable(node)` — Clerk's docs
recommend a real page. **Do not** mount `<PricingTable/>` inside a custom fixed/overlay
container: Clerk's checkout drawer gets mispositioned/masked behind it (learned twice).

---

## 5. `AUTH_MODE`: off / prelaunch / live (the reusable trick)

| Mode | Auth UI | Entitlement | Use it for |
|---|---|---|---|
| **`off`** (default) | none | nobody (via auth) | public/free launch; no payment surface at all |
| **`prelaunch`** | sign-in only, **no checkout** | **signed-in = entitled** | testing every gated feature with a login and **zero payments** |
| **`live`** | sign-in + Go Pro | requires the **paid plan** (`has({plan})`) | real launch |

`prelaunch` is the key to a clean pre-launch: you can exercise all Pro features by
just signing in, and **no visitor ever hits a checkout that can't succeed** (a dev/test
Stripe rejects real cards). At launch you flip `prelaunch → live` — signed-in-but-free
then reverts to anonymous-equivalent and the paid plan becomes the gate.

---

## 6. Gotchas (each cost real debugging)

- **COOP/COEP breaks OAuth popups.** `Cross-Origin-Opener-Policy: same-origin` strips
  `window.opener`, so Clerk's social-login popup breaks. If you set COOP/COEP for
  SharedArrayBuffer, **scope those headers to only the page(s) that need them** — keep
  them off the page hosting sign-in.
- **Plan badge goes stale after a billing change.** The plan claim is baked into the
  session token, which refreshes only periodically. Force `getToken({ skipCache:true })`
  + re-render on focus / interval / modal-close (see §4), or the badge lies until reload.
- **PricingTable in a custom overlay = masked checkout.** Use Clerk's native modal or a
  dedicated page.
- **Identity is the verified email, not the provider.** Signing in with Google then
  Microsoft on the same email = **one** Clerk user (account linking). Good in prod;
  annoying for testing the "free" path with one human — use `you+test@gmail.com` or the
  Gmail dot trick to get distinct test users.
- **Dev vs prod instances are separate.** Test subscriptions in the dev instance do
  **not** carry to production; prod is a different instance with live-mode Stripe.
- **Cancel = at period end.** After a downgrade, `has({plan})` stays `true` until the
  paid period expires (standard Stripe behavior).
- **Publishable key is public** (shipped in the client) — fine to commit; the **secret
  key** is not.
- **Clerk Billing is public beta**, and adds **0.7% per transaction** on top of standard
  Stripe fees.

---

## 7. Prelaunch → production launch checklist

1. **Deploy Clerk to a production instance** → get `pk_live_` / `sk_live_`.
2. **Connect + activate your real Stripe account** (live mode) in Clerk; recreate the
   `pro` plan there.
3. Set the Worker secrets on prod: `CLERK_SECRET_KEY` (`sk_live_`),
   `CLERK_PUBLISHABLE_KEY` (`pk_live_`), `AUTH_MODE=live`. **Don't** set
   `TEST_ENTITLE_SECRET`.
4. Swap the client's inlined publishable key + Frontend API host to the `pk_live_`
   instance.
5. Deploy; verify: signed-out/free = denied, subscribed = entitled.

---

## 8. Testing

- **Local/dev:** `AUTH_MODE=prelaunch` (sign-in = entitled) or `live` with the dev
  gateway + Stripe **test card `4242 4242 4242 4242`**.
- **Headless/CI:** the `X-Test-Entitle: <TEST_ENTITLE_SECRET>` bypass grants entitlement
  without a real login (inert in prod where the secret is unset) — lets tests exercise
  both the entitled and free branches.
- **A second, unsubscribed test user** for the "denied" path: `you+free@gmail.com`
  (email/password) or a Gmail dot-variant.

---

## Reference implementation (this repo)

- **`src/worker.js`** — `requirePro()`, `/api/config`, and the gated endpoints.
- **`public/index.html`** — the Clerk `<script>` loader + sign-in / Go-Pro / badge markup.
- **`public/client.js`** — `initClerk()` / `renderClerk()` / entitlement refresh.
- **`wrangler.toml`** — secret documentation and `[env.staging]` (an isolated staging
  Worker for internet testing without touching production).
- **`test/run.mjs`** — Layer-0 headless tests, incl. the `authMode` and entitlement gates.
