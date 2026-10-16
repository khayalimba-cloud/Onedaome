import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import Database from 'node:sqlite';
import bcrypt from 'bcryptjs';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';
const SQLiteStore = connectSqlite3(session);
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new Database(path.join(__dirname, 'data', 'onedaome.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    vip INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stripe_session_id TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    amount_total INTEGER,
    currency TEXT,
    payment_status TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

if (isProd) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'https://image.tmdb.org', 'data:'],
      frameSrc: ['https://www.youtube-nocookie.com', 'https://stream.mux.com'],
      connectSrc: ["'self'", 'https://api.themoviedb.org', 'https://stream.mux.com'],
      mediaSrc: ["'self'", 'https://stream.mux.com', 'blob:'],
      upgradeInsecureRequests: isProd ? [] : null
    }
  }
}));

// Stripe requires the raw request body for signature verification, so mount before express.json().
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe is not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send('Invalid webhook signature');
  }

  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    const checkout = event.data.object;
    // For card and asynchronous methods, wait for paid status before granting access.
    if (checkout.payment_status === 'paid') {
      const email = (checkout.customer_details?.email || checkout.customer_email || '').trim().toLowerCase();
      if (email) {
        const tx = db.prepare(`
          INSERT OR IGNORE INTO purchases
          (stripe_session_id,email,amount_total,currency,payment_status)
          VALUES (?,?,?,?,?)
        `);
        tx.run(checkout.id, email, checkout.amount_total ?? null, checkout.currency ?? null, checkout.payment_status);
        db.prepare('UPDATE users SET vip=1 WHERE email=?').run(email);
      }
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '20kb' }));
app.use(session({
  name: 'onedaome.sid',
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.join(__dirname, 'data') }),
  secret: process.env.SESSION_SECRET || 'development-only-change-me-before-deploy',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const catalogLimiter = rateLimit({ windowMs: 60 * 1000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false });
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function currentUser(req) {
  if (!req.session.userId) return null;
  return db.prepare('SELECT id,email,vip,created_at FROM users WHERE id=?').get(req.session.userId) || null;
}
function requireAuth(req, res, next) {
  if (!currentUser(req)) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}
function requireVip(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in first.' });
  if (!user.vip) return res.status(403).json({ error: 'VIP access is required.' });
  req.user = user;
  next();
}
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  res.json({ user: user ? { email: user.email, vip: Boolean(user.vip) } : null });
});

app.post('/api/register', authLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!emailRe.test(email) || password.length < 12 || password.length > 200) {
    return res.status(400).json({ error: 'Enter a valid email and a password of 12–200 characters.' });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare('INSERT INTO users(email,password_hash) VALUES (?,?)').run(email, hash);
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Could not start session.' });
      req.session.userId = Number(result.lastInsertRowid);
      res.status(201).json({ user: { email, vip: false } });
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'An account with this email already exists.' });
    console.error(err);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT id,email,password_hash FROM users WHERE email=?').get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Could not start session.' });
    req.session.userId = user.id;
    res.json({ user: { email: user.email, vip: Boolean(db.prepare('SELECT vip FROM users WHERE id=?').get(user.id)?.vip) } });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('onedaome.sid');
    res.json({ ok: true });
  });
});

// TMDB proxy: keeps the TMDB bearer token on the server.
app.get('/api/catalog', catalogLimiter, async (req, res) => {
  if (!process.env.TMDB_READ_TOKEN) return res.status(503).json({ error: 'Catalogue API is not configured on the server.' });
  const allowed = new Set(['trending/all/week','movie/popular','tv/popular','search/multi','search/movie','search/tv','discover/tv','discover/movie']);
  const route = String(req.query.route || 'trending/all/week');
  if (!allowed.has(route)) return res.status(400).json({ error: 'Unsupported catalogue route.' });
  const params = new URLSearchParams();
  params.set('language', String(req.query.language || 'en-US').slice(0, 10));
  params.set('page', String(Math.max(1, Math.min(500, Number.parseInt(req.query.page || '1', 10) || 1))));
  if (route.startsWith('search/')) {
    const q = String(req.query.query || '').trim().slice(0, 100);
    if (!q) return res.status(400).json({ error: 'Search query is required.' });
    params.set('query', q);
    params.set('include_adult', 'false');
  }
  if (route === 'discover/tv') {
    params.set('with_genres', '16');
    params.set('with_original_language', 'ja');
    params.set('sort_by', 'popularity.desc');
  }
  if (route === 'discover/movie') params.set('sort_by', 'popularity.desc');
  try {
    const upstream = await fetch(`https://api.themoviedb.org/3/${route}?${params}`, {
      headers: { Authorization: `Bearer ${process.env.TMDB_READ_TOKEN}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    const payload = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Catalogue provider returned an error.' });
    res.set('Cache-Control', 'public, max-age=60, s-maxage=300');
    res.json(payload);
  } catch (err) {
    console.error('TMDB request failed:', err.message);
    res.status(502).json({ error: 'Catalogue provider is temporarily unavailable.' });
  }
});

app.get('/api/title/:type/:id/videos', catalogLimiter, async (req, res) => {
  if (!process.env.TMDB_READ_TOKEN) return res.status(503).json({ error: 'Catalogue API is not configured.' });
  const type = ['movie','tv'].includes(req.params.type) ? req.params.type : null;
  const id = Number.parseInt(req.params.id, 10);
  if (!type || !Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid title.' });
  try {
    const upstream = await fetch(`https://api.themoviedb.org/3/${type}/${id}/videos?language=en-US`, {
      headers: { Authorization: `Bearer ${process.env.TMDB_READ_TOKEN}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    const payload = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'Could not load videos.' });
    res.set('Cache-Control', 'public, max-age=60, s-maxage=300');
    res.json(payload);
  } catch {
    res.status(502).json({ error: 'Video metadata provider is unavailable.' });
  }
});

app.post('/api/create-vip-checkout', requireAuth, async (req, res) => {
  if (!stripe || !process.env.STRIPE_VIP_PRICE_ID) return res.status(503).json({ error: 'VIP checkout is not configured.' });
  const user = currentUser(req);
  if (user.vip) return res.status(409).json({ error: 'This account already has VIP.' });
  try {
    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: process.env.STRIPE_VIP_PRICE_ID, quantity: 1 }],
      customer_email: user.email,
      client_reference_id: String(user.id),
      metadata: { userId: String(user.id), product: 'onedaome-vip-onetime' },
      success_url: `${process.env.BASE_URL}/?vip=processing`,
      cancel_url: `${process.env.BASE_URL}/?vip=cancelled`
    });
    res.json({ url: checkout.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(502).json({ error: 'Could not start checkout.' });
  }
});

const allowedPlaybackIds = new Set((process.env.MUX_ALLOWED_PLAYBACK_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
function getMuxPrivateKey() {
  if (process.env.MUX_SIGNING_PRIVATE_KEY_BASE64) return Buffer.from(process.env.MUX_SIGNING_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
  return (process.env.MUX_SIGNING_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
}
app.get('/api/playback/:playbackId', requireVip, (req, res) => {
  const playbackId = String(req.params.playbackId);
  if (!allowedPlaybackIds.has(playbackId)) return res.status(404).json({ error: 'This licensed video is not available.' });
  const keyId = process.env.MUX_SIGNING_KEY_ID;
  const privateKey = getMuxPrivateKey();
  if (!keyId || !privateKey) return res.status(503).json({ error: 'Secure playback is not configured.' });
  try {
    const token = jwt.sign(
      { sub: playbackId, aud: 'v', exp: Math.floor(Date.now() / 1000) + 60 * 60, kid: keyId },
      privateKey,
      { algorithm: 'RS256' }
    );
    res.set('Cache-Control', 'no-store');
    res.json({ url: `https://stream.mux.com/${encodeURIComponent(playbackId)}.m3u8?token=${encodeURIComponent(token)}`, expiresIn: 3600 });
  } catch (err) {
    console.error('Playback token signing failed:', err.message);
    res.status(500).json({ error: 'Could not authorize playback.' });
  }
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API endpoint not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'), err => { if (err) next(err); });
});
app.listen(PORT, () => console.log(`Onedaome running on port ${PORT}`));
