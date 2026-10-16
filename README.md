# Onedaome production starter

This is a backend starter, not a turnkey licensed streaming catalogue. It provides:
- Server-side TMDB catalogue proxy (the TMDB token is not sent to the browser).
- Registration/login with password hashing and server-side sessions.
- Stripe Checkout for a one-time $2 USD VIP pass; VIP is granted only after a verified Stripe webhook.
- Signed Mux playback token endpoint restricted to an allowlist of your own Mux playback IDs.
- Optional Adsterra Smartlink button with an honest, optional disclosure.
- Basic security headers, rate limits, and SQLite persistence.

## Important before publishing
1. If the Adsterra token you posted is a real secret/API credential, revoke/rotate it. This project does not use that value as a secret. Put the correct provider credential in `.env` only if a documented server-side API requires it.
2. You must have distribution rights for each full movie/episode. TMDB provides metadata/artwork, not video rights or streams.
3. This starter uses a one-time $2 USD Stripe Checkout price. Configure the correct currency/tax/refund/legal terms for your business and location. Do not advertise “Ad-Free” until all ads are actually disabled for VIP users.
4. Before production, use HTTPS, a durable managed database, reliable backups, monitoring, email verification/password reset, privacy policy, terms, refund policy, and a proper account recovery flow. The SQLite database is suitable for a small test, not a high-traffic deployment.
5. The app's initial session store is SQLite, but production hosting must provide persistent storage or use a managed session/database service.

## Local setup
Requires Node.js 22.5+ (uses the built-in `node:sqlite` module).

```bash
npm install
cp .env.example .env
```

Fill in `.env`. Generate a session secret with:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Then:
```bash
npm start
```
Open `http://localhost:3000`.

## TMDB
Get your API Read Access Token from your TMDB account's API settings. Set `TMDB_READ_TOKEN` in `.env`. The browser calls `/api/catalog`; the server adds the bearer token. Read TMDB's API terms and attribution requirements before launch.

## Stripe VIP setup
1. In Stripe Dashboard, create a one-time Price for $2 USD (or your intended local-currency price).
2. Put the Price ID in `STRIPE_VIP_PRICE_ID` and the secret key in `STRIPE_SECRET_KEY`.
3. For local testing, install Stripe CLI and run:
   `stripe listen --forward-to localhost:3000/api/stripe-webhook`
4. Copy the CLI webhook signing secret into `STRIPE_WEBHOOK_SECRET`.
5. Test a successful Checkout and verify `/api/me` reports `vip: true` after the webhook is received.
6. In production, create a webhook endpoint at `https://YOUR-DOMAIN/api/stripe-webhook`, subscribe to `checkout.session.completed`, and use the endpoint's signing secret.
7. Do not grant VIP just because the browser returned to a success URL. The webhook is the source of truth.

The current sample ties a purchase to the email entered at checkout. The buyer must sign into an account using the same email to access VIP. For production, improve this with email verification and account-linked checkout sessions.

## Mux licensed video setup
Mux is a video hosting/streaming provider, not a catalogue of copyrighted commercial films. Upload only content you own or are licensed to distribute.
1. Create a Mux account and upload your licensed video.
2. Create a **signed** playback ID for the asset.
3. Set `MUX_SIGNING_KEY_ID` and the private signing key in `.env`.
4. Add your signed playback IDs to `MUX_ALLOWED_PLAYBACK_IDS`, comma-separated.
5. Sign in with a VIP account. The frontend requests `/api/playback/:playbackId`; the backend verifies VIP status and returns a short-lived signed HLS URL.
6. Replace the placeholder IDs in the frontend's sample Licensed videos list with your actual IDs.

Mux signing key handling: use a private key from Mux's signing-key dashboard/API. For `MUX_SIGNING_PRIVATE_KEY_BASE64`, base64-encode the full PEM file including BEGIN/END lines. Do not put signing keys in `public/`, Git, or client JavaScript.

## Adsterra and ad disclosure
- Add/verify your website in the Adsterra publisher dashboard and follow its current verification instructions.
- Use the Smartlink supplied in the site's configuration. It is a destination URL, not the same thing as an API token.
- The ad disclosure in this demo is optional and appears once per browser. It does not force a click, open a popunder automatically, or claim an impression has been counted.
- Adsterra may provide different ad formats and requirements for your account. Use only the code and formats shown in your own dashboard, and do not incentivize or artificially generate ad clicks.

## Deploying live
Recommended straightforward path: Render, Railway, Fly.io, or another Node host with HTTPS and persistent storage. Steps vary by host:
1. Push this project to a private Git repository (never commit `.env`).
2. Create a Node web service using `npm install` and `npm start`.
3. Set every `.env` value in the host's secret/environment-variable dashboard.
4. Add a persistent disk or replace SQLite with a managed PostgreSQL database.
5. Configure your custom domain and HTTPS.
6. Configure Stripe's production webhook URL and Mux domain restrictions.
7. Add the live website URL to Adsterra and complete the verification process requested in the publisher dashboard.
8. Test login, logout, checkout, webhook fulfilment, VIP playback, non-VIP denial, mobile layout, and ad disclosure before sharing the URL.

## Limitations to address before a commercial launch
- Add email verification, password reset, CSRF protection, bot controls, privacy/consent handling, support contact, and abuse monitoring.
- Use a managed database and proper migrations for production.
- Add Stripe refunds/cancellations and customer support flows.
- Implement an admin CMS to map titles to licensed Mux playback IDs.
- Add age ratings and regional rights/availability restrictions.
- Check TMDB branding and attribution requirements and Adsterra's current publisher rules.
