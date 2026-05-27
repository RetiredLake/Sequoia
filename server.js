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

const adminKeyPath = path.join(__dirname, '.admin_key');
if (!fs.existsSync(adminKeyPath)) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let key = '';
  for (let i = 0; i < 32; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  fs.writeFileSync(adminKeyPath, key, 'utf8');
}
const adminKey = fs.readFileSync(adminKeyPath, 'utf8').trim();
const users = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
const usersByName = new Map(users.map((u) => [u.name.toLowerCase(), u]));
const userNamesByUuid = new Map(users.map((u) => [u.uuid, u.name]));

const files = {
  votes: path.join(dataDir, 'votes.json'),
  claims: path.join(dataDir, 'claims.json'),
  mods: path.join(dataDir, 'mods.json'),
  blog: path.join(dataDir, 'blog.json'),
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
function saveUsers(newUsers) {
  fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify(newUsers, null, 2));
  users.length = 0;
  users.push(...newUsers);
  usersByName.clear();
  users.forEach((u) => usersByName.set(u.name.toLowerCase(), u));
  userNamesByUuid.clear();
  users.forEach((u) => userNamesByUuid.set(u.uuid, u.name));
}

ensureDataFile(files.votes, { mods: {} });
ensureDataFile(files.claims, { countries: {} });
ensureDataFile(files.mods, {
  suggestions: [
    { key: 'chat_heads', name: 'Chat Heads', link: 'https://modrinth.com/mod/chat-heads' },
    { key: 'create', name: 'Create', link: 'https://www.curseforge.com/minecraft/mc-mods/create' },
    { key: 'sodium', name: 'Sodium', link: 'https://modrinth.com/mod/sodium' },
  ],
});
ensureDataFile(files.blog, {
  posts: [
    {
      id: 'wither-storm-mini-season',
      title: 'Wither Storm Mini Season',
      message:
        'Starting Friday, join us and beat the Wither Storm. We are buying time for the next vanilla season.',
      author: 'Nick',
      createdAt: '2026-05-26T12:00:00.000Z',
      tags: ['Season 19', 'Wither Storm'],
    },
  ],
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));

if (HTTPS_ENABLED) {
  app.set('trust proxy', 1);
}

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('SESSION_SECRET must be set when NODE_ENV=production');
}

app.use(
  session({
    secret: SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: HTTPS_ENABLED },
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

function isAdmin(user) {
  return user?.role === 'admin';
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function makeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

function blogTagOptions(posts) {
  const tags = new Set();
  posts.forEach((post) => normalizeArray(post.tags).forEach((tag) => tags.add(tag)));
  return [...tags];
}

function normalizeBlogPost(post) {
  return { ...post, tags: normalizeArray(post.tags) };
}

function postTagsFromBody(body) {
  const tags = normalizeArray(body.tags)
    .map((tag) => String(tag).trim())
    .filter(Boolean);
  const customTags = String(body.customTags || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  return [...new Set([...tags, ...customTags])];
}

function isAllowedModLink(link) {
  const normalized = String(link || '').toLowerCase();
  return normalized.includes('modrinth') || normalized.includes('curseforge');
}

function voterNames(record, delta) {
  return Object.entries(record?.byUser || {})
    .filter(([, vote]) => Number(vote) === delta)
    .map(([uuid]) => userNamesByUuid.get(uuid) || 'Unknown user');
}

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.isAdmin = isAdmin(req.session.user);
  res.locals.notice = req.session.notice || null;
  res.locals.formatMessage = (message) => {
    let escaped = String(message || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return escaped.replace(urlRegex, (url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });
  };
  req.session.notice = null;
  next();
});

app.get('/login', (req, res) => res.render('login', { ...baseLocals, error: null }));
app.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const user = usersByName.get(username.toLowerCase());
  if (!user) {
    return res.status(401).render('login', {
      ...baseLocals,
      error: 'Unknown username. Please use a whitelisted username.',
    });
  }

  const isUserAdmin = user.role === 'admin';
  if (isUserAdmin) {
    const providedKey = req.body.adminKey;
    if (!providedKey) {
      return res.render('admin_key_prompt', {
        ...baseLocals,
        username: user.name,
        error: null,
      });
    }
    if (providedKey !== adminKey) {
      return res.status(401).render('admin_key_prompt', {
        ...baseLocals,
        username: user.name,
        error: 'Invalid admin key.',
      });
    }
  }

  req.session.user = { uuid: user.uuid, name: user.name, role: user.role || 'user' };
  res.redirect(req.query.next || '/');
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.get('/settings', (req, res) => {
  if (!isAdmin(req.session.user)) {
    req.session.notice = 'Only admins can access settings.';
    return res.redirect('/');
  }
  res.render('settings', {
    ...baseLocals,
    usersList: users,
  });
});

app.post('/settings/toggle-admin', (req, res) => {
  if (!isAdmin(req.session.user)) {
    req.session.notice = 'Only admins can access settings.';
    return res.redirect('/');
  }
  const uuid = String(req.body.uuid || '');
  const isAdminVal = req.body.isAdmin === 'true';
  const updatedUsers = users.map((u) => {
    if (u.uuid === uuid) {
      const copy = { ...u };
      if (isAdminVal) {
        copy.role = 'admin';
      } else {
        delete copy.role;
      }
      return copy;
    }
    return u;
  });
  saveUsers(updatedUsers);
  if (req.session.user && req.session.user.uuid === uuid) {
    req.session.user.role = isAdminVal ? 'admin' : 'user';
  }
  res.redirect('/settings');
});

app.post('/settings/delete-user', (req, res) => {
  if (!isAdmin(req.session.user)) {
    req.session.notice = 'Only admins can access settings.';
    return res.redirect('/');
  }
  const uuid = String(req.body.uuid || '');
  const updatedUsers = users.filter((u) => u.uuid !== uuid);
  saveUsers(updatedUsers);
  res.redirect('/settings');
});

app.post('/settings/add-user', (req, res) => {
  if (!isAdmin(req.session.user)) {
    req.session.notice = 'Only admins can access settings.';
    return res.redirect('/');
  }
  const username = String(req.body.username || '').trim();
  const uuid = String(req.body.uuid || '').trim();
  const isManager = req.body.isManager === 'true';

  if (!username || !uuid) {
    req.session.notice = 'Username and UUID are required.';
    return res.redirect('/settings');
  }

  const newUser = { uuid, name: username };
  if (isManager) {
    newUser.role = 'admin';
  }
  const updatedUsers = [...users, newUser];
  saveUsers(updatedUsers);
  res.redirect('/settings');
});

app.post('/mods/vote', (req, res) => {
  if (!req.session.user) {
    req.session.notice = 'Sign in with a username before voting. Votes are tied to usernames.';
    return res.redirect('/mods');
  }
  const modKey = String(req.body.modKey || '');
  const delta = Number(req.body.delta || 0);
  const modData = readJson(files.mods);
  if (!modData.suggestions.find((m) => m.key === modKey) || ![-1, 1].includes(delta)) {
    req.session.notice = 'Invalid vote request.';
    return res.redirect('/mods');
  }

  const votes = readJson(files.votes);
  votes.mods[modKey] ||= { total: 0, byUser: {} };
  const record = votes.mods[modKey];
  const prior = Number(record.byUser[req.session.user.uuid] || 0);
  const nextVote = prior === delta ? 0 : delta;
  record.total += nextVote - prior;
  if (nextVote) {
    record.byUser[req.session.user.uuid] = nextVote;
  } else {
    delete record.byUser[req.session.user.uuid];
  }
  writeJson(files.votes, votes);
  res.redirect('/mods');
});

app.post('/mods/suggest', (req, res) => {
  if (!req.session.user) {
    req.session.notice = 'Log in before suggesting a mod.';
    return res.redirect('/mods');
  }
  const name = String(req.body.name || '').trim();
  const link = String(req.body.link || '').trim();
  const key = makeKey(name);
  if (!name || !key) {
    req.session.notice = 'Add a mod name before suggesting it.';
    return res.redirect('/mods');
  }
  if (!link || !isAllowedModLink(link)) {
    req.session.notice = 'Add a Modrinth or CurseForge link before suggesting a mod.';
    return res.redirect('/mods');
  }
  const modData = readJson(files.mods);
  if (modData.suggestions.some((m) => m.key === key)) {
    req.session.notice = 'That mod is already suggested.';
    return res.redirect('/mods');
  }
  modData.suggestions.push({ key, name, link, suggestedBy: req.session.user.name });
  writeJson(files.mods, modData);
  res.redirect('/mods');
});

app.post('/mods/delete', (req, res) => {
  if (!isAdmin(req.session.user)) {
    req.session.notice = 'Only admins can delete mod suggestions.';
    return res.redirect('/mods');
  }
  const modKey = String(req.body.modKey || '');
  const modData = readJson(files.mods);
  modData.suggestions = modData.suggestions.filter((m) => m.key !== modKey);
  writeJson(files.mods, modData);
  const votes = readJson(files.votes);
  delete votes.mods[modKey];
  writeJson(files.votes, votes);
  res.redirect('/mods');
});

app.post('/blog/post', (req, res) => {
  if (!isAdmin(req.session.user)) {
    req.session.notice = 'Only moderators can post updates.';
    return res.redirect('/');
  }
  const title = String(req.body.title || '').trim();
  const message = String(req.body.message || '').trim();
  if (!title || !message) {
    req.session.notice = 'Posts need both a title and a message.';
    return res.redirect('/');
  }
  const blog = readJson(files.blog);
  blog.posts.unshift({
    id: `${Date.now()}-${makeKey(title)}`,
    title,
    message,
    author: req.session.user.name,
    createdAt: new Date().toISOString(),
    tags: postTagsFromBody(req.body),
  });
  writeJson(files.blog, blog);
  res.redirect('/');
});

app.post('/blog/edit', (req, res) => {
  if (!isAdmin(req.session.user)) {
    req.session.notice = 'Only moderators can edit posts.';
    return res.redirect('/');
  }
  const postId = String(req.body.postId || '');
  const title = String(req.body.title || '').trim();
  const message = String(req.body.message || '').trim();
  if (!title || !message) {
    req.session.notice = 'Posts need both a title and a message.';
    return res.redirect('/');
  }
  const blog = readJson(files.blog);
  const post = blog.posts.find((entry) => entry.id === postId);
  if (!post) {
    req.session.notice = 'That post could not be found.';
    return res.redirect('/');
  }
  post.title = title;
  post.message = message;
  post.tags = postTagsFromBody(req.body);
  post.editedAt = new Date().toISOString();
  writeJson(files.blog, blog);
  res.redirect('/');
});

app.post('/blog/vote', (req, res) => {
  if (!req.session.user) {
    req.session.notice = 'Log in before voting on posts.';
    return res.redirect('/');
  }
  const postId = String(req.body.postId || '');
  const delta = Number(req.body.delta || 0);
  const blog = readJson(files.blog);
  if (!blog.posts.some((post) => post.id === postId) || ![-1, 1].includes(delta)) {
    req.session.notice = 'Invalid post vote.';
    return res.redirect('/');
  }
  const votes = readJson(files.votes);
  votes.blog ||= {};
  votes.blog[postId] ||= { total: 0, byUser: {} };
  const record = votes.blog[postId];
  const prior = Number(record.byUser[req.session.user.uuid] || 0);
  record.total += delta - prior;
  record.byUser[req.session.user.uuid] = delta;
  writeJson(files.votes, votes);
  res.redirect(req.get('referer') || '/');
});

app.post('/blog/delete', (req, res) => {
  if (!isAdmin(req.session.user)) {
    req.session.notice = 'Only moderators can delete posts.';
    return res.redirect('/');
  }
  const postId = String(req.body.postId || '');
  const blog = readJson(files.blog);
  blog.posts = blog.posts.filter((post) => post.id !== postId);
  writeJson(files.blog, blog);
  const votes = readJson(files.votes);
  if (votes.blog) {
    delete votes.blog[postId];
    writeJson(files.votes, votes);
  }
  res.redirect('/');
});

app.get('/map', (_, res) => res.redirect(302, 'https://map.retiredlake.com'));

app.get('/', (req, res) => {
  const blog = readJson(files.blog);
  const votes = readJson(files.votes);
  const selectedTag = String(req.query.tag || '');
  const allPosts = blog.posts.map(normalizeBlogPost);
  const posts = selectedTag ? allPosts.filter((post) => post.tags.includes(selectedTag)) : allPosts;
  const postsWithVotes = posts.map((post) => ({ ...post, score: votes.blog?.[post.id]?.total || 0 }));
  res.render('index', {
    ...baseLocals,
    posts: postsWithVotes,
    tags: blogTagOptions(allPosts),
    selectedTag,
  });
});
app.get('/mods', (req, res) => {
  const votes = readJson(files.votes);
  const modData = readJson(files.mods);
  const currentUuid = req.session.user?.uuid;
  const mods = modData.suggestions.map((m) => {
    const record = votes.mods?.[m.key] || { total: 0, byUser: {} };
    return {
      ...m,
      score: record.total || 0,
      currentVote: Number(record.byUser?.[currentUuid] || 0),
      upvoters: voterNames(record, 1),
      downvoters: voterNames(record, -1),
    };
  });
  res.render('mods', { ...baseLocals, mods });
});
app.get('/claims', (req, res) => res.render('claims', { ...baseLocals }));

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
