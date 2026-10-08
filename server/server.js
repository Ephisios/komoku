'use strict';

/**
 * Serveur Komoku : reçoit les rapports des agents, les stocke dans SQLite
 * et sert le tableau de bord.
 *
 * Deux portes d'entrée, deux authentifications distinctes :
 *   - POST /api/ingest   : les agents, avec l'en-tête X-Api-Key
 *   - tout le reste      : toi, en authentification HTTP Basic
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const { evaluateMachine } = require('./lib/health');
const { prevoirSaturationDisque } = require('./lib/forecast');
const { normalizePayload } = require('./lib/normalize');

// ------------------------------------------------------------- configuration

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const CONFIG = {
  port: parseInt(env('PORT', '8080'), 10),
  host: env('HOST', '0.0.0.0'),
  apiKey: env('API_KEY', ''),
  dashPass: env('DASH_PASS', ''),
  dbPath: env('DB_PATH', path.join(__dirname, 'data', 'komoku.db')),
  retentionDays: parseInt(env('RETENTION_DAYS', '30'), 10),
  offlineAfterMinutes: parseInt(env('OFFLINE_AFTER_MINUTES', '12'), 10),
  vpnRequired: env('VPN_REQUIRED', 'false') === 'true',
  sessionDays: parseInt(env('SESSION_DAYS', '14'), 10),
  maxBodyBytes: 1024 * 1024,
};

for (const [key, label] of [['apiKey', 'API_KEY'], ['dashPass', 'DASH_PASS']]) {
  if (!CONFIG[key]) {
    console.error(
      `[komoku] ${label} n'est pas défini. Génère-en un avec :\n` +
      `         node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`
    );
    process.exit(1);
  }
}

// ------------------------------------------------------------------ stockage

fs.mkdirSync(path.dirname(CONFIG.dbPath), { recursive: true });
const db = new DatabaseSync(CONFIG.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS machines (
    id          TEXT PRIMARY KEY,
    hostname    TEXT NOT NULL,
    label       TEXT NOT NULL DEFAULT '',
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    payload     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS samples (
    machine_id   TEXT NOT NULL,
    ts           INTEGER NOT NULL,
    cpu          REAL,
    ram          REAL,
    gpu          REAL,
    disk         REAL,
    vpn          INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_samples_machine_ts ON samples (machine_id, ts);
`);

// Migration : la colonne forecast est arrivee apres les premieres bases.
// CREATE TABLE IF NOT EXISTS ne l'ajoute pas a une table deja creee.
const colonnes = db.prepare('PRAGMA table_info(machines)').all().map((c) => c.name);
if (!colonnes.includes('forecast')) {
  db.exec('ALTER TABLE machines ADD COLUMN forecast TEXT');
  console.log('[komoku] migration : colonne forecast ajoutee');
}

const q = {
  upsert: db.prepare(`
    INSERT INTO machines (id, hostname, label, first_seen, last_seen, payload)
    VALUES (@id, @hostname, @label, @now, @now, @payload)
    ON CONFLICT(id) DO UPDATE SET
      hostname  = excluded.hostname,
      last_seen = excluded.last_seen,
      payload   = excluded.payload,
      -- une étiquette posée depuis le tableau de bord l'emporte sur celle de l'agent
      label     = CASE WHEN machines.label = '' THEN excluded.label ELSE machines.label END
  `),
  addSample: db.prepare(`
    INSERT INTO samples (machine_id, ts, cpu, ram, gpu, disk, vpn)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  allMachines: db.prepare('SELECT * FROM machines ORDER BY hostname COLLATE NOCASE'),
  oneMachine: db.prepare('SELECT * FROM machines WHERE id = ?'),
  setLabel: db.prepare('UPDATE machines SET label = ? WHERE id = ?'),
  deleteMachine: db.prepare('DELETE FROM machines WHERE id = ?'),
  deleteSamples: db.prepare('DELETE FROM samples WHERE machine_id = ?'),
  history: db.prepare(`
    SELECT ts, cpu, ram, gpu, disk, vpn FROM samples
    WHERE machine_id = ? AND ts >= ? ORDER BY ts
  `),
  prune: db.prepare('DELETE FROM samples WHERE ts < ?'),
  diskSeries: db.prepare('SELECT ts, disk FROM samples WHERE machine_id = ? AND ts >= ? ORDER BY ts'),
  setForecast: db.prepare('UPDATE machines SET forecast = ? WHERE id = ?'),
};

/**
 * Recalcule la prevision de saturation d'un poste.
 *
 * A la reception d'un rapport, donc au plus une fois toutes les trois minutes
 * et par poste : une regression sur deux semaines coute quelques millisecondes,
 * mais la refaire pour tout le parc a chaque rafraichissement du tableau de
 * bord serait du gaspillage.
 */
function recalculerPrevision(machineId, now) {
  try {
    const depuis = now - 15 * 86400000;
    const points = q.diskSeries.all(machineId, depuis);
    const prevision = prevoirSaturationDisque(points, { now });
    q.setForecast.run(JSON.stringify(prevision), machineId);
    return prevision;
  } catch (err) {
    console.error('[komoku] prevision impossible pour', machineId, ':', err.message);
    return null;
  }
}

function pruneOldSamples() {
  const cutoff = Date.now() - CONFIG.retentionDays * 86400000;
  // node:sqlite peut renvoyer un BigInt pour changes
  const changes = Number(q.prune.run(cutoff).changes);
  if (changes > 0) console.log(`[komoku] purge : ${changes} mesures de plus de ${CONFIG.retentionDays} jours`);
}
pruneOldSamples();
setInterval(pruneOldSamples, 3600000).unref();

// -------------------------------------------------------------------- outils

/** Comparaison à temps constant : empêche de deviner un secret octet par octet. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) {
    // On compare quand même, pour ne pas révéler la longueur par le temps de réponse.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('corps de requête trop volumineux'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------- sessions */

/**
 * Le secret de session dérive du mot de passe : en changer invalide
 * automatiquement toutes les sessions ouvertes, ce qui est le comportement
 * attendu quand on vient de révoquer un accès.
 */
const SESSION_SECRET = crypto.createHash('sha256')
  .update(`komoku-session|${CONFIG.dashPass}`).digest();

const COOKIE_NAME = 'komoku_session';

function issueToken() {
  const exp = Date.now() + CONFIG.sessionDays * 86400000;
  const nonce = crypto.randomBytes(9).toString('base64url');
  const body = `${exp}.${nonce}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [exp, nonce, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET)
    .update(`${exp}.${nonce}`).digest('base64url');
  if (!safeEqual(sig, expected)) return false;
  return Number(exp) > Date.now();
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecureRequest(req) {
  return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
}

/** Petit frein sur les tentatives de connexion, utile dès que le serveur est public. */
const loginAttempts = new Map();
const LOGIN_MAX = 10;
const LOGIN_WINDOW_MS = 15 * 60000;

function loginBlocked(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX;
}

function noteFailedLogin(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { first: Date.now(), count: 1 });
  } else {
    entry.count += 1;
  }
}

setInterval(() => {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  for (const [ip, e] of loginAttempts) if (e.first < cutoff) loginAttempts.delete(ip);
}, LOGIN_WINDOW_MS).unref();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'inconnu';
}

/** Session par cookie pour le navigateur, Basic en secours pour curl et scripts. */
function isAuthenticated(req) {
  if (verifyToken(parseCookies(req)[COOKIE_NAME])) return true;

  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    if (safeEqual(pass, CONFIG.dashPass)) return true;
  }
  return false;
}

// -------------------------------------------------------------------- lecture

function rowToMachine(row, { withPayload = true } = {}) {
  let payload = {};
  try {
    // Les rapports stockés par une version antérieure du serveur n'ont pas
    // forcément été remis en forme : on le refait à la lecture.
    payload = normalizePayload(JSON.parse(row.payload));
  } catch {
    payload = {};
  }
  let forecast = null;
  try { if (row.forecast) forecast = JSON.parse(row.forecast); } catch { /* ignore */ }

  const health = evaluateMachine(payload, row.last_seen, CONFIG, { forecast });
  const base = {
    id: row.id,
    hostname: row.hostname,
    label: row.label,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    health,
    forecast,
  };
  return withPayload ? { ...base, payload } : base;
}

// ------------------------------------------------------------------- routage

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, rel);
  // Empêche de remonter hors de public/ via ../
  if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== path.join(PUBLIC_DIR, 'index.html')) {
    return send(res, 403, 'Interdit.');
  }
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Introuvable.');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

async function handleIngest(req, res) {
  const key = req.headers['x-api-key'] || '';
  if (!safeEqual(key, CONFIG.apiKey)) {
    return send(res, 401, { error: 'clé API invalide' });
  }

  let payload;
  try {
    payload = normalizePayload(JSON.parse(await readBody(req, CONFIG.maxBodyBytes)));
  } catch (err) {
    return send(res, err.status || 400, { error: 'JSON illisible' });
  }

  const id = String(payload.machineId || '').trim();
  const hostname = String(payload.hostname || '').trim();
  if (!/^[a-f0-9]{8,64}$/i.test(id)) return send(res, 400, { error: 'machineId invalide' });
  if (!hostname) return send(res, 400, { error: 'hostname manquant' });

  const now = Date.now();
  q.upsert.run({
    id,
    hostname: hostname.slice(0, 64),
    label: String(payload.label || '').slice(0, 120),
    now,
    payload: JSON.stringify(payload),
  });

  // Série temporelle réduite : on ne garde que les quatre courbes utiles.
  const volumes = payload.disk?.volumes || [];
  const worstDisk = volumes.length ? Math.max(...volumes.map((v) => v.usedPercent ?? 0)) : null;
  q.addSample.run(
    id,
    now,
    payload.cpu?.loadPercent ?? null,
    payload.memory?.usedPercent ?? null,
    payload.gpu?.loadPercent ?? null,
    worstDisk,
    payload.vpn?.connected ? 1 : 0
  );

  recalculerPrevision(id, now);

  return send(res, 200, { ok: true, receivedAt: now });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, 'URL invalide.');
  }
  const route = url.pathname.replace(/\/+$/, '') || '/';

  try {
    // Les agents : clé API, pas d'authentification Basic.
    if (route === '/api/ingest') {
      if (req.method !== 'POST') return send(res, 405, { error: 'méthode non autorisée' });
      return await handleIngest(req, res);
    }

    if (route === '/api/health') {
      return send(res, 200, { ok: true, uptimeSeconds: Math.round(process.uptime()) });
    }

    if (route === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (loginBlocked(ip)) {
        return send(res, 429, { error: 'Trop de tentatives. Réessaie dans un quart d’heure.' });
      }
      let body = {};
      try { body = JSON.parse(await readBody(req, 4096)); } catch {}
      if (!safeEqual(body.password || '', CONFIG.dashPass)) {
        noteFailedLogin(ip);
        return send(res, 401, { error: 'Mot de passe incorrect.' });
      }
      loginAttempts.delete(ip);
      const flags = [
        `${COOKIE_NAME}=${issueToken()}`,
        'Path=/', 'HttpOnly', 'SameSite=Lax',
        `Max-Age=${CONFIG.sessionDays * 86400}`,
      ];
      if (isSecureRequest(req)) flags.push('Secure');
      return send(res, 200, { ok: true }, { 'Set-Cookie': flags.join('; ') });
    }

    if (route === '/api/logout' && req.method === 'POST') {
      return send(res, 200, { ok: true }, {
        'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      });
    }

    // Tout le reste appartient au tableau de bord.
    if (!isAuthenticated(req)) {
      // Une navigation non authentifiée atterrit sur la page de connexion ;
      // un appel d'API reçoit un 401 que le tableau de bord sait interpréter.
      const wantsHtml = (req.headers.accept || '').includes('text/html');
      if (wantsHtml && req.method === 'GET' && !route.startsWith('/api/')) {
        return serveStatic(req, res, '/login.html');
      }
      return send(res, 401, { error: 'authentification requise' });
    }

    if (route === '/login.html') {
      // Déjà connecté : inutile de repasser par le formulaire.
      return send(res, 302, '', { Location: '/' });
    }

    if (route === '/api/machines' && req.method === 'GET') {
      const machines = q.allMachines.all().map((r) => rowToMachine(r));
      return send(res, 200, {
        now: Date.now(),
        offlineAfterMinutes: CONFIG.offlineAfterMinutes,
        machines,
      });
    }

    const match = route.match(/^\/api\/machines\/([a-f0-9]{8,64})(\/history)?$/i);
    if (match) {
      const [, id, isHistory] = match;
      const row = q.oneMachine.get(id);
      if (!row) return send(res, 404, { error: 'poste inconnu' });

      if (isHistory && req.method === 'GET') {
        const hours = Math.min(Math.max(parseInt(url.searchParams.get('hours') || '24', 10) || 24, 1), 720);
        const since = Date.now() - hours * 3600000;
        return send(res, 200, { id, hours, points: q.history.all(id, since) });
      }
      if (!isHistory && req.method === 'GET') {
        return send(res, 200, rowToMachine(row));
      }
      if (!isHistory && req.method === 'PATCH') {
        const body = JSON.parse(await readBody(req, 4096));
        q.setLabel.run(String(body.label || '').slice(0, 120), id);
        return send(res, 200, { ok: true });
      }
      if (!isHistory && req.method === 'DELETE') {
        q.deleteSamples.run(id);
        q.deleteMachine.run(id);
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: 'méthode non autorisée' });
    }

    if (req.method === 'GET') return serveStatic(req, res, route);
    return send(res, 404, { error: 'route inconnue' });
  } catch (err) {
    console.error('[komoku] erreur :', err);
    return send(res, err.status || 500, { error: 'erreur interne' });
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`[komoku] à l'écoute sur http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`[komoku] base : ${CONFIG.dbPath}`);
  console.log(`[komoku] hors ligne au-delà de ${CONFIG.offlineAfterMinutes} min sans signe de vie`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[komoku] arrêt (${sig})`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
