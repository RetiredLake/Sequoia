const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const session = require('express-session');

const app = express();
const HTTP_PORT = Number(process.env.HTTP_PORT || 80);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 443);
const FORCE_HTTPS = process.env.FORCE_HTTPS === 'true';
const HTTPS_ENABLED = process.env.HTTPS === 'true';

const dataDir = path.join(__dirname, 'data');
const users = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
const usersByName = new Map(users.map((u) => [u.name.toLowerCase(), u]));

const files = {
  votes: path.join(dataDir, 'votes.json'),
  claims: path.join(dataDir, 'claims.json'),
};

function ensureDataFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
  }
}
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

ensureDataFile(files.votes, { mods: {} });
ensureDataFile(files.claims, { countries: {} });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  })
);

const baseLocals = {
  serverAddress: 'play.retiredlake.com',
  nav: [
    { href: '/map', label: 'map' },
    { href: '/mods', label: 'mods' },
    { href: '/claims', label: 'claims' },
  ],
};

const seedMods = [
  { key: 'chat_heads', name: 'Chat Heads', link: 'modrinth' },
  { key: 'create', name: 'Create', link: 'curseforge' },
  { key: 'sodium', name: 'Sodium', link: 'modrinth' },
];

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.notice = req.session.notice || null;
  req.session.notice = null;
  next();
});

app.get('/login', (req, res) => res.render('login', { ...baseLocals, error: null }));
app.post('/login', (req, res) => {
  const user = usersByName.get(String(req.body.username || '').trim().toLowerCase());
  if (!user) {
    return res.status(401).render('login', {
      ...baseLocals,
      error: 'Unknown username. Please use a whitelisted username.',
    });
  }
  req.session.user = { uuid: user.uuid, name: user.name };
  res.redirect(req.query.next || '/');
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.post('/mods/vote', (req, res) => {
  if (!req.session.user) {
    req.session.notice = 'Sign in with a username before voting. Votes are tied to usernames.';
    return res.redirect('/mods');
  }
  const modKey = String(req.body.modKey || '');
  const delta = Number(req.body.delta || 0);
  if (!seedMods.find((m) => m.key === modKey) || ![-1, 1].includes(delta)) {
    req.session.notice = 'Invalid vote request.';
    return res.redirect('/mods');
  }

  const votes = readJson(files.votes);
  votes.mods[modKey] ||= { total: 0, byUser: {} };
  const record = votes.mods[modKey];
  const prior = Number(record.byUser[req.session.user.uuid] || 0);
  record.total += delta - prior;
  record.byUser[req.session.user.uuid] = delta;
  writeJson(files.votes, votes);
  res.redirect('/mods');
});

app.post('/claims/claim', (req, res) => {
  if (!req.session.user) {
    req.session.notice = 'Sign in with a username before claiming a country.';
    return res.redirect('/claims');
  }
  const country = String(req.body.country || 'Country');
  const claims = readJson(files.claims);
  claims.countries[country] = req.session.user.name;
  writeJson(files.claims, claims);
  res.redirect('/claims');
});

app.get('/map', (_, res) => res.redirect(302, 'https://map.retiredlake.com'));

app.get('/', (req, res) => res.render('index', { ...baseLocals }));
app.get('/mods', (req, res) => {
  const votes = readJson(files.votes);
  const mods = seedMods.map((m) => ({ ...m, score: votes.mods[m.key]?.total || 0 }));
  res.render('mods', { ...baseLocals, mods });
});
app.get('/claims', (req, res) => {
  const claims = readJson(files.claims);
  const country = 'Country';
  const claimedBy = claims.countries[country] || 'Unclaimed';
  res.render('claims', { ...baseLocals, country, claimedBy });
});

function startServer() {
  if (HTTPS_ENABLED) {
    const keyPath = process.env.SSL_KEY_PATH;
    const certPath = process.env.SSL_CERT_PATH;
    if (!keyPath || !certPath) throw new Error('HTTPS=true requires SSL_KEY_PATH and SSL_CERT_PATH');

    const options = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    https.createServer(options, app).listen(HTTPS_PORT, () => {
      console.log(`HTTPS server listening on port ${HTTPS_PORT}`);
    });

    if (FORCE_HTTPS) {
      http.createServer((req, res) => {
        res.writeHead(301, { Location: `https://${req.headers.host?.split(':')[0]}:${HTTPS_PORT}${req.url}` });
        res.end();
      }).listen(HTTP_PORT, () => {
        console.log(`HTTP redirect listening on port ${HTTP_PORT}`);
      });
    }
    return;
  }

  http.createServer(app).listen(HTTP_PORT, () => {
    console.log(`HTTP server listening on port ${HTTP_PORT}`);
  });
}

startServer();
