import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { models, defaultModel } from './src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = readIntegerEnv('PORT', 3000, { min: 1, max: 65535 });
const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const promptAssistantProvider = process.env.PROMPT_ASSISTANT_PROVIDER || 'openrouter';
const promptAssistantBaseUrl = (
  process.env.PROMPT_ASSISTANT_BASE_URL ||
  (promptAssistantProvider === 'openrouter' ? 'https://openrouter.ai/api/v1' : baseUrl)
).replace(/\/$/, '');
const promptAssistantApiKey = process.env.PROMPT_ASSISTANT_API_KEY
  || (promptAssistantProvider === 'openrouter' ? process.env.OPENROUTER_API_KEY || '' : process.env.OPENAI_API_KEY || '');
const promptAssistantModel = process.env.PROMPT_ASSISTANT_MODEL || (promptAssistantProvider === 'openrouter' ? 'openrouter/free' : 'gpt-4o-mini');
const imageApiTimeoutMs = readIntegerEnv('IMAGE_API_TIMEOUT_MS', 900000, { min: 5000, max: 30 * 60 * 1000 });
const promptAssistantTimeoutMs = readIntegerEnv('PROMPT_ASSISTANT_TIMEOUT_MS', 60000, { min: 5000, max: 5 * 60 * 1000 });
const imageApiRetries = readIntegerEnv('IMAGE_API_RETRIES', 3, { min: 0, max: 10 });
const imageApiRetryDelayMs = readIntegerEnv('IMAGE_API_RETRY_DELAY_MS', 2000, { min: 100, max: 60000 });
const maxTaskImages = readIntegerEnv('MAX_TASK_IMAGES', 50, { min: 1, max: 500 });
const maxTaskConcurrency = readIntegerEnv('MAX_TASK_CONCURRENCY', 10, { min: 1, max: 100 });
const globalImageConcurrency = readIntegerEnv('IMAGE_API_GLOBAL_CONCURRENCY', maxTaskConcurrency, { min: 1, max: 100 });
const maxPromptLength = readIntegerEnv('MAX_PROMPT_LENGTH', 4000, { min: 3, max: 20000 });
const maxReferenceImages = readIntegerEnv('MAX_REFERENCE_IMAGES', 10, { min: 1, max: 20 });
const maxReferenceImageBytes = readIntegerEnv('MAX_REFERENCE_IMAGE_BYTES', 0, { min: 0 });
const maxReferenceTotalBytes = readIntegerEnv('MAX_REFERENCE_TOTAL_BYTES', 0, { min: 0 });
const maxGeneratedImageBytes = readIntegerEnv('MAX_GENERATED_IMAGE_BYTES', 80 * 1024 * 1024, { min: 1024, max: 500 * 1024 * 1024 });
const accessPassword = process.env.ACCESS_PASSWORD || '';
const accessCookieName = 'ias_access';
const accessToken = accessPassword ? createAccessToken(accessPassword) : '';
const allowRegistration = (process.env.ALLOW_REGISTRATION || 'true') !== 'false';
const sessionCookieName = 'ias_session';
let sessions = new Map();
const imageApiLimiter = createLimiter(globalImageConcurrency);
const promptAssistantLimiter = createLimiter(readIntegerEnv('PROMPT_ASSISTANT_CONCURRENCY', 3, { min: 1, max: 20 }));

const dataDir = path.join(__dirname, 'data');
const generatedDir = path.join(__dirname, 'public', 'generated');
const uploadsDir = path.join(dataDir, 'uploads');
const thumbsDir = path.join(dataDir, 'thumbs');
const tasksFile = path.join(dataDir, 'tasks.json');
const usersFile = path.join(dataDir, 'users.json');
const invitesFile = path.join(dataDir, 'invites.json');
const sessionsFile = path.join(dataDir, 'sessions.json');
const runningControllers = new Map();
const eventClients = new Set();

const sizes = [
  '3840x2160',
  '2160x3840'
];

const allowedSizes = new Set(sizes);
const minEdge = 16;
const maxEdge = readIntegerEnv('MAX_IMAGE_EDGE', 4096, { min: minEdge, max: 16384 });
const maxPixels = readIntegerEnv('MAX_IMAGE_PIXELS', maxEdge * maxEdge, { min: minEdge * minEdge, max: 16384 * 16384 });
const qualities = new Set(['auto', 'low', 'medium', 'high']);
const backgrounds = new Set(['auto', 'transparent', 'opaque']);
const formats = new Set(['auto', 'png', 'jpeg', 'webp']);
const taskStatuses = new Set(['all', 'active', 'pending', 'running', 'succeeded', 'failed', 'canceled']);
const taskModes = new Set(['all', 'text', 'image']);
const uploadMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: maxReferenceImages,
    ...(maxReferenceImageBytes > 0 ? { fileSize: maxReferenceImageBytes } : {}),
    fieldSize: 1024 * 1024
  },
  fileFilter(_req, file, callback) {
    if (!isSupportedUploadMime(file.mimetype)) {
      callback(new Error('参考图仅支持 PNG、JPEG 或 WebP 图片。'));
      return;
    }

    callback(null, true);
  }
});

let tasks = [];
let users = [];
let invites = [];
let writeChain = Promise.resolve();
let usersWriteChain = Promise.resolve();
let invitesWriteChain = Promise.resolve();
let sessionsWriteChain = Promise.resolve();

await ensureStorage();
tasks = await loadTasksFromDisk();
users = await loadUsersFromDisk();
invites = await loadInvitesFromDisk();
sessions = await loadSessionsFromDisk();
await resetInterruptedTasks();

process.on('unhandledRejection', (error) => {
  console.error('[process:unhandled-rejection]', error);
});
process.on('uncaughtException', (error) => {
  console.error('[process:uncaught-exception]', error);
});

app.use(express.json({ limit: '2mb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  );
  next();
});
app.get('/generated/thumb/:filename', requireAccess, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const srcPath = path.join(generatedDir, filename);
  const thumbName = filename.replace(/\.[^.]+$/, '.jpg');
  const thumbPath = path.join(thumbsDir, thumbName);

  try {
    if (fsSync.existsSync(thumbPath)) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.sendFile(thumbPath);
    }
    await fs.access(srcPath);
    await sharp(srcPath)
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toFile(thumbPath);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(thumbPath);
  } catch {
    res.status(404).end();
  }
});
app.use('/generated', requireAccess, express.static(generatedDir, {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  }
}));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  }
}));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    configured: Boolean(process.env.OPENAI_API_KEY),
    model: defaultModel,
    tasks: tasks.length
  });
});

app.get('/api/config', (req, res) => {
  const sessionUser = getSessionUser(req);
  res.json({
    model: defaultModel,
    promptAssistantModel,
    promptAssistantProvider,
    models,
    sizes,
    qualities: [...qualities],
    backgrounds: [...backgrounds],
    formats: [...formats],
    maxTaskImages,
    maxTaskConcurrency,
    maxReferenceImages,
    maxReferenceImageBytes,
    maxReferenceTotalBytes,
    maxPromptLength,
    promptAssistantEnabled: Boolean(promptAssistantApiKey),
    maxImageEdge: maxEdge,
    maxImagePixels: maxPixels,
    configured: Boolean(process.env.OPENAI_API_KEY),
    authRequired: true,
    authenticated: isAuthenticated(req),
    isAdmin: isAdmin(req),
    currentUser: sessionUser || null,
    allowRegistration,
    registrationCodeRequired: true, // 邀请码现在是必填项
    hasUsers: users.length > 0
  });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码。' });
  }

  // 管理员账号：用户名 admin + 密码 = ACCESS_PASSWORD
  if (username === 'admin') {
    if (!accessPassword) {
      return res.status(401).json({ error: '未配置管理员密码。' });
    }
    if (password !== accessPassword) {
      return res.status(401).json({ error: '用户名或密码错误。' });
    }
    res.cookie(accessCookieName, accessToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isHttps(req),
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
    return res.json({ ok: true, user: 'admin' });
  }

  const user = users.find(u => u.username === username);
  if (!user || hashPassword(password, user.salt) !== user.passwordHash) {
    return res.status(401).json({ error: '用户名或密码错误。' });
  }

  const token = createSessionToken();
  sessions.set(token, { username: user.username, createdAt: Date.now() });
  persistSessions();
  res.cookie(sessionCookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps(req),
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
  res.json({ ok: true, user: user.username });
});

app.post('/api/register', async (req, res) => {
  if (!allowRegistration) {
    return res.status(403).json({ error: '注册功能已关闭。' });
  }

  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const code = String(req.body?.code || '').trim();

  if (!username || username.length < 2 || username.length > 20) {
    return res.status(400).json({ error: '用户名需要 2-20 个字符。' });
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username)) {
    return res.status(400).json({ error: '用户名只能包含字母、数字、下划线或中文。' });
  }
  if (username.toLowerCase() === 'admin') {
    return res.status(400).json({ error: '该用户名为保留字段。' });
  }
  if (password.length < 6 || password.length > 64) {
    return res.status(400).json({ error: '密码需要 6-64 个字符。' });
  }
  if (!code) {
    return res.status(400).json({ error: '请输入邀请码。' });
  }

  // 验证邀请码：必须存在且未使用
  const invite = invites.find(i => i.code === code);
  if (!invite) {
    return res.status(403).json({ error: '邀请码无效。' });
  }
  if (invite.usedAt) {
    return res.status(403).json({ error: '该邀请码已被使用。' });
  }

  if (users.some(u => u.username === username)) {
    return res.status(409).json({ error: '该用户名已被注册。' });
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: createId(),
    username,
    passwordHash: hashPassword(password, salt),
    salt,
    createdAt: new Date().toISOString(),
    invitedBy: invite.code
  };
  users.push(user);
  await persistUsers();

  // 标记邀请码已使用
  invite.usedAt = new Date().toISOString();
  invite.usedBy = username;
  await persistInvites();

  const token = createSessionToken();
  sessions.set(token, { username: user.username, createdAt: Date.now() });
  persistSessions();
  res.cookie(sessionCookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps(req),
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
  console.log('[user:registered]', username, 'via invite', invite.code);
  res.status(201).json({ ok: true, user: user.username });
});

// 邀请码管理接口 - 仅管理员可访问
app.get('/api/admin/invites', requireAdmin, (req, res) => {
  res.json({
    invites: invites.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  });
});

app.post('/api/admin/invites', requireAdmin, async (req, res) => {
  const count = Math.min(Math.max(Number(req.body?.count) || 1, 1), 20);
  const created = [];
  for (let i = 0; i < count; i++) {
    const invite = {
      code: generateInviteCode(),
      createdAt: new Date().toISOString(),
      createdBy: getSessionUser(req) || 'admin',
      usedAt: null,
      usedBy: null
    };
    invites.push(invite);
    created.push(invite);
  }
  await persistInvites();
  res.json({ created });
});

app.delete('/api/admin/invites/:code', requireAdmin, async (req, res) => {
  const idx = invites.findIndex(i => i.code === req.params.code);
  if (idx === -1) {
    return res.status(404).json({ error: '邀请码不存在。' });
  }
  if (invites[idx].usedAt) {
    return res.status(400).json({ error: '已使用的邀请码不可删除。' });
  }
  invites.splice(idx, 1);
  await persistInvites();
  res.status(204).end();
});

app.post('/api/logout', (req, res) => {
  const token = getCookie(req, sessionCookieName);
  if (token) {
    sessions.delete(token);
    persistSessions();
  }
  res.clearCookie(accessCookieName, { path: '/' });
  res.clearCookie(sessionCookieName, { path: '/' });
  res.json({ ok: true });
});

app.use('/api', requireAccess);

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  sendEvent(res, 'connected', {
    now: new Date().toISOString(),
    tasks: tasks.length
  });

  eventClients.add(res);
  const heartbeat = setInterval(() => {
    if (!sendEvent(res, 'ping', { now: new Date().toISOString() })) {
      clearInterval(heartbeat);
      eventClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    eventClients.delete(res);
  });
});

app.get('/api/tasks', (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1);
  const pageSize = Math.max(1, Math.min(Number.parseInt(req.query.pageSize || '1', 10) || 1, 50));
  const status = taskStatuses.has(req.query.status) ? req.query.status : 'all';
  const mode = taskModes.has(req.query.mode) ? req.query.mode : 'all';

  const filtered = sortTasks(tasks).filter((task) => {
    const statusMatch =
      status === 'all' ||
      (status === 'active' && ['pending', 'running'].includes(task.status)) ||
      task.status === status;
    const modeMatch = mode === 'all' || task.mode === mode;
    return statusMatch && modeMatch;
  });

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;

  res.json({
    tasks: filtered.slice(start, start + pageSize).map(publicTask),
    pagination: {
      page: safePage,
      pageSize,
      total,
      totalPages
    }
  });
});

app.post('/api/tasks', upload.array('referenceImages', maxReferenceImages), async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: '服务端还没有配置 OPENAI_API_KEY。' });
  }

  const body = req.is('multipart/form-data') ? req.body : req.body || {};
  const files = req.files || [];

  try {
    const task = await createTask(body, files);
    tasks.unshift(task);
    await persistTasks();
    processTask(task.id).catch((error) => console.error('[task:unhandled]', task.id, error));
    res.status(201).json({ task: publicTask(task) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/tasks/:id/cancel', async (req, res) => {
  const task = findTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: '任务不存在。' });
  }

  if (!['pending', 'running'].includes(task.status)) {
    return res.status(400).json({ error: '只有等待中或生成中的任务可以取消。' });
  }

  task.status = 'canceled';
  task.completedAt = new Date().toISOString();
  task.updatedAt = task.completedAt;
  abortTask(task.id);
  await persistTasks();
  res.json({ task: publicTask(task) });
});

app.post('/api/tasks/:id/retry', async (req, res) => {
  const source = findTask(req.params.id);
  if (!source) {
    return res.status(404).json({ error: '任务不存在。' });
  }

  if (['pending', 'running'].includes(source.status)) {
    return res.status(400).json({ error: '任务正在执行，不能重试。' });
  }

  const task = {
    ...source,
    id: createId(),
    status: 'pending',
    error: '',
    images: [],
    progress: { done: 0, total: source.count },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: '',
    completedAt: '',
    retryOf: source.id
  };

  tasks.unshift(task);
  await persistTasks();
  processTask(task.id).catch((error) => console.error('[task:unhandled]', task.id, error));
  res.status(201).json({ task: publicTask(task) });
});

app.delete('/api/tasks/:id', async (req, res) => {
  const index = tasks.findIndex((task) => task.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: '任务不存在。' });
  }

  const [task] = tasks.splice(index, 1);
  await deleteTaskFiles(task);
  await persistTasks();
  res.status(204).end();
});

app.post('/api/prompt-assistant', async (req, res) => {
  if (!promptAssistantApiKey) {
    return res.status(500).json({ error: '服务端还没有配置提示词助手 API Key。' });
  }

  try {
    const result = await createPromptSuggestion(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/generate', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: '服务端还没有配置 OPENAI_API_KEY。' });
  }

  try {
    const task = await createTask({ ...req.body, count: req.body.n || req.body.count }, []);
    task.status = 'running';
    task.startedAt = new Date().toISOString();
    const images = await generateTaskImages(task, task.count);
    res.json({
      created: Math.floor(Date.now() / 1000),
      model: task.model,
      images: images.map((image) => ({
        id: image.id,
        url: image.url,
        revised_prompt: image.revisedPrompt,
        mime_type: image.mimeType
      }))
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.use((error, _req, res, _next) => {
  const { status, message } = formatRequestError(error);
  console.error('[request:error]', message);
  res.status(status).json({ error: message });
});

app.get('*', (req, res) => {
  if (path.extname(req.path)) {
    return res.status(404).end();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = await startServer(port);
setupGracefulShutdown(server);

async function ensureStorage() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(generatedDir, { recursive: true });
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(thumbsDir, { recursive: true });
  if (!fsSync.existsSync(tasksFile)) {
    await fs.writeFile(tasksFile, '[]\n', 'utf8');
  }
  if (!fsSync.existsSync(usersFile)) {
    await fs.writeFile(usersFile, '[]\n', 'utf8');
  }
  if (!fsSync.existsSync(invitesFile)) {
    await fs.writeFile(invitesFile, '[]\n', 'utf8');
  }
  if (!fsSync.existsSync(sessionsFile)) {
    await fs.writeFile(sessionsFile, '{}\n', 'utf8');
  }
}

async function loadUsersFromDisk() {
  try {
    return JSON.parse(await fs.readFile(usersFile, 'utf8'));
  } catch (error) {
    console.warn('[users:load:primary-failed]', error instanceof Error ? error.message : String(error));
    return [];
  }
}

async function loadInvitesFromDisk() {
  try {
    return JSON.parse(await fs.readFile(invitesFile, 'utf8'));
  } catch (error) {
    console.warn('[invites:load:failed]', error instanceof Error ? error.message : String(error));
    return [];
  }
}

function persistInvites() {
  invitesWriteChain = invitesWriteChain.catch(() => {}).then(async () => {
    const tempFile = `${invitesFile}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tempFile, JSON.stringify(invites, null, 2), 'utf8');
      await fs.rename(tempFile, invitesFile);
    } catch (error) {
      console.error('[invites:persist:failed]', error);
      try { await fs.unlink(tempFile); } catch {}
    }
  });
  return invitesWriteChain;
}

async function loadSessionsFromDisk() {
  try {
    const data = JSON.parse(await fs.readFile(sessionsFile, 'utf8'));
    const map = new Map();
    const now = Date.now();
    const maxAge = 30 * 24 * 60 * 60 * 1000;
    for (const [token, session] of Object.entries(data)) {
      if (session?.createdAt && now - session.createdAt < maxAge) {
        map.set(token, session);
      }
    }
    return map;
  } catch (error) {
    console.warn('[sessions:load:failed]', error instanceof Error ? error.message : String(error));
    return new Map();
  }
}

function persistSessions() {
  sessionsWriteChain = sessionsWriteChain.catch(() => {}).then(async () => {
    const tempFile = `${sessionsFile}.${process.pid}.tmp`;
    try {
      const obj = Object.fromEntries(sessions);
      await fs.writeFile(tempFile, JSON.stringify(obj, null, 2), 'utf8');
      await fs.rename(tempFile, sessionsFile);
    } catch (error) {
      console.error('[sessions:persist:failed]', error);
      try { await fs.unlink(tempFile); } catch {}
    }
  });
  return sessionsWriteChain;
}

async function loadTasksFromDisk() {
  try {
    return normalizeLoadedTasks(JSON.parse(await fs.readFile(tasksFile, 'utf8')));
  } catch (error) {
    console.warn('[tasks:load:primary-failed]', error instanceof Error ? error.message : String(error));
  }

  try {
    const backupFile = `${tasksFile}.bak`;
    return normalizeLoadedTasks(JSON.parse(await fs.readFile(backupFile, 'utf8')));
  } catch (error) {
    console.warn('[tasks:load:backup-failed]', error instanceof Error ? error.message : String(error));
    return [];
  }
}

function normalizeLoadedTasks(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((task) => task && typeof task === 'object' && task.id)
    .map((task) => {
      const images = Array.isArray(task.images) ? task.images : [];
      const count = clampInteger(task.count, { min: 1, max: maxTaskImages, fallback: Math.max(1, images.length) });
      return {
        ...task,
        mode: task.mode === 'image' ? 'image' : 'text',
        status: ['pending', 'running', 'succeeded', 'failed', 'canceled'].includes(task.status) ? task.status : 'failed',
        error: String(task.error || ''),
        images,
        referenceImages: Array.isArray(task.referenceImages) ? task.referenceImages : [],
        count,
        concurrency: clampInteger(task.concurrency, { min: 1, max: Math.min(maxTaskConcurrency, count), fallback: 1 }),
        progress: normalizeProgress(task.progress, images.length, count),
        createdAt: task.createdAt || new Date().toISOString(),
        updatedAt: task.updatedAt || task.createdAt || new Date().toISOString(),
        startedAt: task.startedAt || '',
        completedAt: task.completedAt || ''
      };
    });
}

function normalizeProgress(progress, doneFallback, totalFallback) {
  return {
    done: clampInteger(progress?.done, { min: 0, max: totalFallback, fallback: doneFallback }),
    total: clampInteger(progress?.total, { min: 1, max: maxTaskImages, fallback: totalFallback })
  };
}

async function resetInterruptedTasks() {
  const now = new Date().toISOString();
  let changed = false;
  for (const task of tasks) {
    if (['pending', 'running'].includes(task.status)) {
      task.status = 'failed';
      task.error = '服务重启后任务中断，请重试。';
      task.completedAt = now;
      task.updatedAt = now;
      changed = true;
    }
  }
  if (changed) {
    await persistTasks();
  }
}

function persistTasks() {
  writeChain = writeChain.catch((error) => {
    console.error('[tasks:persist:previous-failed]', error instanceof Error ? error.message : String(error));
  }).then(async () => {
    const tempFile = `${tasksFile}.${process.pid}.tmp`;
    const backupFile = `${tasksFile}.bak`;
    const serialized = `${JSON.stringify(tasks, null, 2)}\n`;

    try {
      await fs.writeFile(tempFile, serialized, 'utf8');
      if (fsSync.existsSync(tasksFile)) {
        await fs.copyFile(tasksFile, backupFile);
      }
      await fs.rename(tempFile, tasksFile);
      broadcastTasksChanged();
    } catch (error) {
      await fs.rm(tempFile, { force: true }).catch(() => {});
      throw error;
    }
  });
  return writeChain;
}

function broadcastTasksChanged() {
  if (!eventClients.size) {
    return;
  }

  const payload = {
    now: new Date().toISOString(),
    tasks: tasks.length
  };

  for (const client of eventClients) {
    if (!sendEvent(client, 'tasks-updated', payload)) {
      eventClients.delete(client);
    }
  }
}

function sendEvent(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function validateReferenceFiles(files = []) {
  if (files.length > maxReferenceImages) {
    throw new Error(`参考图最多 ${maxReferenceImages} 张。`);
  }

  let totalBytes = 0;
  for (const file of files) {
    if (!isSupportedUploadMime(file.mimetype)) {
      throw new Error('参考图仅支持 PNG、JPEG 或 WebP 图片。');
    }

    totalBytes += file.size || 0;
    if (maxReferenceImageBytes > 0 && (file.size || 0) > maxReferenceImageBytes) {
      throw new Error(`单张参考图不能超过 ${formatBytes(maxReferenceImageBytes)}。`);
    }
  }

  if (maxReferenceTotalBytes > 0 && totalBytes > maxReferenceTotalBytes) {
    throw new Error(`参考图总大小不能超过 ${formatBytes(maxReferenceTotalBytes)}。`);
  }
}

async function createTask(body, files) {
  const mode = body.mode === 'image' ? 'image' : 'text';
  const prompt = String(body.prompt || '').trim();
  if (prompt.length < 3) {
    throw new Error('请输入至少 3 个字符的提示词。');
  }
  if (prompt.length > maxPromptLength) {
    throw new Error(`提示词不能超过 ${maxPromptLength} 个字符。`);
  }

  validateReferenceFiles(files);

  const sizeResult = normalizeSize(body.size || '1024x1024');
  if (sizeResult.error) {
    throw new Error(sizeResult.error);
  }

  if (mode === 'image' && files.length === 0) {
    throw new Error('图生图请上传至少 1 张参考图。');
  }

  const count = clampInteger(body.count || body.n, { min: 1, max: maxTaskImages, fallback: 1 });
  const concurrency = clampInteger(body.concurrency || body.requestConcurrency, {
    min: 1,
    max: Math.min(maxTaskConcurrency, count),
    fallback: 1
  });
  const outputFormatCandidate = String(body.output_format || body.outputFormat || '');
  const outputFormat = formats.has(outputFormatCandidate) ? outputFormatCandidate : 'png';
  const qualityCandidate = String(body.quality || '');
  const backgroundCandidate = String(body.background || '');
  const modelCandidate = String(body.model || '');
  const model = models.includes(modelCandidate) ? modelCandidate : defaultModel;
  const now = new Date().toISOString();
  const id = createId();
  const referenceImages = await saveReferenceFiles(id, files);

  return {
    id,
    mode,
    prompt,
    model,
    size: sizeResult.value,
    quality: qualities.has(qualityCandidate) ? qualityCandidate : 'auto',
    background: backgrounds.has(backgroundCandidate) ? backgroundCandidate : 'auto',
    outputFormat,
    count,
    concurrency,
    status: 'pending',
    error: '',
    images: [],
    referenceImages,
    progress: { done: 0, total: count },
    createdAt: now,
    updatedAt: now,
    startedAt: '',
    completedAt: ''
  };
}

async function saveReferenceFiles(taskId, files) {
  if (!files.length) {
    return [];
  }

  const taskUploadDir = path.join(uploadsDir, taskId);
  await fs.mkdir(taskUploadDir, { recursive: true });

  const saved = [];
  for (const [index, file] of files.entries()) {
    const extension = extensionFromMime(file.mimetype) || path.extname(file.originalname).replace('.', '') || 'png';
    const filename = `reference-${index + 1}.${extension}`;
    const absolutePath = path.join(taskUploadDir, filename);
    await fs.writeFile(absolutePath, file.buffer);
    saved.push({
      filename,
      path: absolutePath,
      mimeType: file.mimetype,
      size: file.size
    });
  }

  return saved;
}

function findTask(id) {
  return tasks.find((task) => task.id === id);
}

async function processTask(taskId) {
  const task = findTask(taskId);
  if (!task || task.status !== 'pending') {
    return;
  }

  task.status = 'running';
  task.error = '';
  task.startedAt = new Date().toISOString();
  task.updatedAt = task.startedAt;
  await persistTasks();

  try {
    await generateTaskImages(task, task.count);
    const currentTask = findTask(taskId);
    if (!currentTask || currentTask.status === 'canceled') {
      return;
    }

    currentTask.status = currentTask.images.length === currentTask.count ? 'succeeded' : 'canceled';
    currentTask.completedAt = new Date().toISOString();
    currentTask.updatedAt = currentTask.completedAt;
    await persistTasks();
  } catch (error) {
    const currentTask = findTask(taskId);
    if (!currentTask || currentTask.status === 'canceled') {
      return;
    }

    currentTask.status = 'failed';
    currentTask.error = error instanceof Error ? error.message : String(error);
    currentTask.completedAt = new Date().toISOString();
    currentTask.updatedAt = currentTask.completedAt;
    console.error('[task:failed]', { id: taskId, error: currentTask.error });
    await persistTasks();
  } finally {
    runningControllers.delete(taskId);
  }
}

async function generateTaskImages(task, total) {
  const pendingIndexes = Array.from({ length: total }, (_value, index) => index);
  const workers = Array.from(
    { length: Math.min(task.concurrency, total) },
    () => runImageWorker(task, pendingIndexes)
  );

  await Promise.all(workers);
  return task.images;
}

async function runImageWorker(task, pendingIndexes) {
  while (pendingIndexes.length) {
    const index = pendingIndexes.shift();
    const currentTask = findTask(task.id) || task;
    if (['canceled', 'failed'].includes(currentTask.status)) {
      return;
    }

    const image = await generateSingleImage(currentTask, index);
    if (['canceled', 'failed'].includes(currentTask.status)) {
      return;
    }
    currentTask.images.push(image);
    currentTask.progress.done = currentTask.images.length;
    currentTask.updatedAt = new Date().toISOString();
    await persistTasks();
  }
}

async function generateSingleImage(task, index) {
  const startedAt = Date.now();
  const payload = buildImagePayload(task);
  const result = await callImageApiWithRetry(task.id, payload, task.referenceImages);
  const item = result.data?.[0];
  if (!item?.b64_json && !item?.url) {
    throw new Error('接口没有返回图片数据。');
  }

  const mimeType = `image/${task.outputFormat === 'auto' ? 'png' : task.outputFormat}`;
  const buffer = item.b64_json
    ? decodeBase64Image(item.b64_json)
    : await downloadImageUrl(task.id, item.url);
  validateGeneratedImageBuffer(buffer);
  const extension = extensionFromMime(mimeType);
  const filename = `${task.id}-${index + 1}.${extension}`;
  await fs.writeFile(path.join(generatedDir, filename), buffer);

  console.info('[generate:success]', {
    taskId: task.id,
    size: task.size,
    model: task.model,
    elapsedMs: Date.now() - startedAt
  });

  return {
    id: `${task.id}-${index + 1}`,
    filename,
    url: `/generated/${filename}`,
    mimeType,
    revisedPrompt: item.revised_prompt || '',
    createdAt: new Date().toISOString()
  };
}

function buildImagePayload(task) {
  const payload = {
    model: task.model,
    prompt: task.prompt,
    size: task.size,
    quality: task.quality,
    background: task.background,
    n: 1
  };

  if (task.outputFormat !== 'auto') {
    payload.output_format = task.outputFormat;
  }

  return payload;
}

async function createPromptSuggestion(body) {
  const mode = body.mode === 'image' ? 'image' : 'text';
  const action = ['polish', 'expand', 'ideas'].includes(body.action) ? body.action : 'polish';
  const prompt = String(body.prompt || '').trim();
  const style = String(body.style || '').trim().slice(0, 80);
  const size = String(body.size || '').trim().slice(0, 40);

  if (action !== 'ideas' && prompt.length < 3) {
    throw new Error('请先输入至少 3 个字符的提示词。');
  }
  if (prompt.length > maxPromptLength) {
    throw new Error(`提示词不能超过 ${maxPromptLength} 个字符。`);
  }

  let payload = buildPromptAssistantPayload({ action, mode, prompt, style, size });
  let result;
  let usedModel = promptAssistantModel;

  const fallbackModels = promptAssistantProvider === 'openrouter'
    ? [
        'google/gemma-3-27b-it:free',
        'meta-llama/llama-4-scout:free',
        'meta-llama/llama-4-maverick:free',
        'qwen/qwen3-30b-a3b:free',
        'openrouter/free'
      ].filter(m => m !== promptAssistantModel)
    : [];

  try {
    result = await promptAssistantLimiter(() => callTextApi(payload));
  } catch (primaryError) {
    if (!fallbackModels.length) throw primaryError;

    let fallbackSucceeded = false;
    for (const fallbackModel of fallbackModels) {
      try {
        console.warn('[prompt-assistant:fallback]', { from: promptAssistantModel, to: fallbackModel, error: primaryError.message });
        const fallbackPayload = { ...payload, model: fallbackModel };
        result = await promptAssistantLimiter(() => callTextApi(fallbackPayload));
        usedModel = fallbackModel;
        fallbackSucceeded = true;
        break;
      } catch (fallbackError) {
        console.warn('[prompt-assistant:fallback-failed]', { model: fallbackModel, error: fallbackError.message });
      }
    }
    if (!fallbackSucceeded) throw primaryError;
  }

  const content = extractAssistantContent(result);
  const suggestion = parsePromptAssistantContent(content);

  return {
    action,
    model: usedModel,
    prompt: suggestion.prompt,
    title: suggestion.title,
    notes: suggestion.notes
  };
}

function buildPromptAssistantPayload({ action, mode, prompt, style, size }) {
  const templates = {
    polish: {
      temperature: 0.3,
      system: [
        '你是 AI 图像提示词润色专家。',
        '规则：',
        '1. 绝对不能改变用户的主题、主体和核心意图',
        '2. 只做措辞优化：让描述更精准、更适合 AI 理解',
        '3. 可以补充 2-3 个细节词（如光线、质感），但不要大幅扩展',
        '4. 输出的 prompt 长度应接近原始输入，不要写成长文',
        '5. 只输出 JSON，格式：{"title":"2-4字标题","prompt":"润色后的提示词","notes":["改了什么1","改了什么2"]}'
      ].join('\n'),
      user: (p, ctx) => `润色这段提示词，保持主题不变：\n「${p}」${ctx}`
    },
    expand: {
      temperature: 0.55,
      system: [
        '你是 AI 图像提示词扩写专家。',
        '规则：',
        '1. 保留用户的原始主题和主体',
        '2. 大幅补充画面细节：场景、构图、光线、材质、色调、氛围、镜头语言',
        '3. 输出的 prompt 应比原始输入长很多（150-400字），像一段完整的画面描述',
        '4. 可以加入摄影/设计英文术语（如 cinematic lighting, bokeh）',
        '5. 只输出 JSON，格式：{"title":"2-4字标题","prompt":"扩写后的提示词","notes":["补充了什么1","补充了什么2"]}'
      ].join('\n'),
      user: (p, ctx) => `扩写这段提示词，大幅丰富画面描述：\n「${p}」${ctx}`
    },
    ideas: {
      temperature: 0.9,
      system: [
        '你是富有创意的 AI 图像灵感顾问。',
        '规则：',
        '1. 如果用户有输入，以它为灵感起点，但给出新颖有趣的创意方向',
        '2. 如果用户没有输入，自由发挥一个有审美的原创图像创意',
        '3. prompt 要具体可用，包含主题、场景、风格、氛围（80-250字）',
        '4. title 要吸引人，像一个作品名',
        '5. 只输出 JSON，格式：{"title":"创意标题","prompt":"完整的创意提示词","notes":["创意亮点1","创意亮点2"]}'
      ].join('\n'),
      user: (p, ctx) => p
        ? `以此为灵感起点，给出一个新颖的图像创意：\n「${p}」${ctx}`
        : `给我一个有审美的原创图像创意。${ctx}`
    }
  };

  const tpl = templates[action];
  const contextParts = [
    mode === 'image' ? '\n模式：图生图（有参考图）' : '',
    style && style !== 'auto' ? `\n风格：${style}` : '',
    size ? `\n尺寸：${size}` : ''
  ].join('');

  const payload = {
    model: promptAssistantModel,
    temperature: tpl.temperature,
    messages: [
      { role: 'system', content: tpl.system },
      { role: 'user', content: tpl.user(prompt, contextParts) }
    ]
  };

  if (promptAssistantProvider !== 'openrouter') {
    payload.response_format = { type: 'json_object' };
  }

  return payload;
}

async function callTextApi(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), promptAssistantTimeoutMs);

  try {
    const response = await fetch(`${promptAssistantBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${promptAssistantApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const contentType = response.headers.get('content-type') || '';
    const result = contentType.includes('application/json')
      ? await response.json()
      : { error: summarizeText(await response.text()) };

    if (!response.ok) {
      throw new Error(normalizeApiError(result));
    }

    return result;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('提示词助手响应超时，请稍后重试。');
    }

    if (error instanceof Error && error.message !== 'fetch failed') {
      throw error;
    }

    throw new Error(`调用提示词助手失败：${describeFetchError(error)}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractAssistantContent(result) {
  const content = result?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('提示词助手没有返回内容。');
  }

  return Array.isArray(content)
    ? content.map((part) => part.text || '').join('\n')
    : String(content);
}

function parsePromptAssistantContent(content) {
  const fallback = summarizeText(content);

  try {
    const parsed = JSON.parse(content);
    const prompt = String(parsed.prompt || '').trim();
    if (!prompt) {
      throw new Error('empty prompt');
    }

    return {
      title: String(parsed.title || '提示词建议').trim().slice(0, 80),
      prompt: prompt.slice(0, maxPromptLength),
      notes: Array.isArray(parsed.notes)
        ? parsed.notes.map((note) => String(note).trim()).filter(Boolean).slice(0, 4)
        : []
    };
  } catch {
    return {
      title: '提示词建议',
      prompt: fallback,
      notes: ['上游返回了非标准 JSON，已自动提取主要内容。']
    };
  }
}

async function callImageApiWithRetry(taskId, payload, referenceImages = []) {
  let lastError;

  for (let attempt = 1; attempt <= imageApiRetries + 1; attempt += 1) {
    if (findTask(taskId)?.status === 'canceled') {
      throw new Error('任务已取消。');
    }

    try {
      return await imageApiLimiter(async () => {
        if (findTask(taskId)?.status === 'canceled') {
          throw new Error('任务已取消。');
        }
        return callImageApi(taskId, payload, referenceImages);
      });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const shouldRetry = attempt <= imageApiRetries && isRetryableImageError(message);

      if (!shouldRetry) {
        throw error;
      }

      console.warn('[generate:retry]', {
        taskId,
        attempt,
        nextAttempt: attempt + 1,
        error: message
      });
      await sleep(imageApiRetryDelayMs * attempt);
    }
  }

  throw lastError;
}

async function callImageApi(taskId, payload, referenceImages = []) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), imageApiTimeoutMs);
  registerController(taskId, controller);

  try {
    let response;
    if (referenceImages.length) {
      const formData = new FormData();
      const editPayload = omitAutoFields(payload);
      for (const [key, value] of Object.entries(editPayload)) {
        formData.set(key, String(value));
      }

      for (const image of referenceImages) {
        const blob = new Blob([await fs.readFile(image.path)], { type: image.mimeType });
        formData.append('image', blob, image.filename);
      }

      response = await fetch(`${baseUrl}/images/edits`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: formData,
        signal: controller.signal
      });
    } else {
      const generationPayload = omitAutoFields(payload);
      response = await fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(generationPayload),
        signal: controller.signal
      });
    }

    const contentType = response.headers.get('content-type') || '';
    const result = contentType.includes('application/json')
      ? await response.json()
      : { error: summarizeText(await response.text()) };

    if (!response.ok) {
      throw new Error(normalizeApiError(result));
    }

    return result;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(findTask(taskId)?.status === 'canceled' ? '任务已取消。' : '图片生成超时。可以稍后重试，或降低尺寸/质量后再生成。');
    }

    if (error instanceof Error && error.message !== 'fetch failed') {
      throw error;
    }

    throw new Error(`调用图片 API 失败：${describeFetchError(error)}`);
  } finally {
    clearTimeout(timeoutId);
    unregisterController(taskId, controller);
  }
}

function isRetryableImageError(message) {
  return /fetch failed|UND_ERR_CONNECT_TIMEOUT|Connect Timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|5\d\d|timeout/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function omitAutoFields(payload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([_key, value]) => value !== 'auto' && value !== '' && value !== undefined)
  );
}

function abortTask(taskId) {
  const controllers = runningControllers.get(taskId);
  if (!controllers) {
    return;
  }

  for (const controller of controllers) {
    controller.abort();
  }

  runningControllers.delete(taskId);
}

function registerController(taskId, controller) {
  const controllers = runningControllers.get(taskId) || new Set();
  controllers.add(controller);
  runningControllers.set(taskId, controllers);
}

function unregisterController(taskId, controller) {
  const controllers = runningControllers.get(taskId);
  if (!controllers) {
    return;
  }

  controllers.delete(controller);
  if (!controllers.size) {
    runningControllers.delete(taskId);
  }
}

function decodeBase64Image(base64) {
  const buffer = Buffer.from(String(base64 || ''), 'base64');
  validateGeneratedImageBuffer(buffer);
  return buffer;
}

async function downloadImageUrl(taskId, url) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('接口返回的图片 URL 不合法。');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('接口返回的图片 URL 协议不受支持。');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), imageApiTimeoutMs);
  registerController(taskId, controller);

  try {
    const response = await fetch(parsedUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`下载图片失败，HTTP ${response.status}。`);
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxGeneratedImageBytes) {
      throw new Error(`生成图片超过 ${formatBytes(maxGeneratedImageBytes)}，已拒绝保存。`);
    }

    return await readResponseBuffer(response, maxGeneratedImageBytes);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(findTask(taskId)?.status === 'canceled' ? '任务已取消。' : '下载生成图片超时。');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    unregisterController(taskId, controller);
  }
}

async function readResponseBuffer(response, maxBytes) {
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    validateGeneratedImageBuffer(buffer);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`生成图片超过 ${formatBytes(maxBytes)}，已拒绝保存。`);
    }

    chunks.push(Buffer.from(value));
  }

  const buffer = Buffer.concat(chunks, total);
  validateGeneratedImageBuffer(buffer);
  return buffer;
}

function validateGeneratedImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('接口返回的图片数据为空。');
  }

  if (buffer.length > maxGeneratedImageBytes) {
    throw new Error(`生成图片超过 ${formatBytes(maxGeneratedImageBytes)}，已拒绝保存。`);
  }
}

async function deleteTaskFiles(task) {
  await Promise.allSettled([
    ...task.images.map((image) => fs.rm(path.join(generatedDir, image.filename), { force: true })),
    fs.rm(path.join(uploadsDir, task.id), { recursive: true, force: true })
  ]);
}

function publicTask(task) {
  return {
    id: task.id,
    mode: task.mode,
    prompt: task.prompt,
    model: task.model,
    size: task.size,
    quality: task.quality,
    background: task.background,
    outputFormat: task.outputFormat,
    count: task.count,
    concurrency: task.concurrency,
    status: task.status,
    error: task.error,
    images: task.images,
    progress: task.progress,
    referenceImageCount: task.referenceImages?.length || 0,
    retryOf: task.retryOf,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt
  };
}

function requireAccess(req, res, next) {
  if (isAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: '请先登录。' });
}

function isAuthenticated(req) {
  // Session-based auth (user accounts)
  if (getSessionUser(req)) return true;
  // Legacy: ACCESS_PASSWORD cookie
  if (accessPassword && getCookie(req, accessCookieName) === accessToken) return true;
  return false;
}

function isAdmin(req) {
  // 通过 ACCESS_PASSWORD 登录的视为管理员
  return Boolean(accessPassword && getCookie(req, accessCookieName) === accessToken);
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) {
    next();
    return;
  }
  res.status(403).json({ error: '仅管理员可访问。' });
}

function generateInviteCode() {
  // 形如 IAS-XXXX-XXXX 的易读邀请码
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 0/O/1/I
  const part = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `IAS-${part(4)}-${part(4)}`;
}

function getSessionUser(req) {
  // 管理员 cookie 返回 admin 作为当前用户
  if (accessPassword && getCookie(req, accessCookieName) === accessToken) return 'admin';
  const token = getCookie(req, sessionCookieName);
  if (!token) return null;
  const session = sessions.get(token);
  return session?.username || null;
}

function createSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

function persistUsers() {
  usersWriteChain = usersWriteChain.catch(() => {}).then(async () => {
    const tempFile = `${usersFile}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tempFile, JSON.stringify(users, null, 2) + '\n', 'utf8');
      await fs.rename(tempFile, usersFile);
    } catch (error) {
      await fs.rm(tempFile, { force: true }).catch(() => {});
      throw error;
    }
  });
  return usersWriteChain;
}

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [rawKey, ...rawValue] = cookie.trim().split('=');
    if (rawKey === name) {
      return decodeURIComponent(rawValue.join('='));
    }
  }
  return '';
}

function createAccessToken(password) {
  return crypto.createHash('sha256').update(`image-api-studio:${password}`).digest('hex');
}

function isHttps(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function sortTasks(taskList) {
  return [...taskList].sort((left, right) => Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt));
}

function createId() {
  return crypto.randomBytes(10).toString('hex');
}

function normalizeApiError(result) {
  if (typeof result?.error === 'string') {
    return result.error;
  }

  if (result?.error?.message) {
    return result.error.message;
  }

  return '图片 API 返回了错误，请查看 details。';
}

function describeFetchError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts = [error.message];
  if (error.cause?.code) {
    parts.push(`code=${error.cause.code}`);
  }

  if (error.cause?.message) {
    parts.push(`cause=${error.cause.message}`);
  }

  return parts.join('; ');
}

function summarizeText(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || '上游接口返回了非 JSON 响应。';
}

function normalizeSize(value) {
  const size = String(value || '').trim().toLowerCase();
  if (allowedSizes.has(size)) {
    return { value: size };
  }

  if (!size) {
    return { value: '1024x1024' };
  }

  const match = size.match(/^(\d{2,4})x(\d{2,4})$/);
  if (!match) {
    return { error: '尺寸格式不正确，请使用 WIDTHxHEIGHT，例如 1024x1024。' };
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  const error = validateSize(width, height);

  if (error) {
    return { error };
  }

  return { value: `${width}x${height}` };
}

function validateSize(width, height) {
  const pixels = width * height;

  if (width % 16 !== 0 || height % 16 !== 0) {
    return '尺寸宽高都必须是 16 的倍数。';
  }

  if (width < minEdge || height < minEdge) {
    return `尺寸宽高不能小于 ${minEdge}。`;
  }

  if (Math.max(width, height) > maxEdge) {
    return `尺寸最长边不能超过 ${maxEdge}。`;
  }

  if (pixels > maxPixels) {
    return `尺寸总像素不能超过 ${maxPixels}。`;
  }

  return '';
}

function extensionFromMime(mimeType = 'image/png') {
  if (mimeType.includes('jpeg')) {
    return 'jpg';
  }
  if (mimeType.includes('webp')) {
    return 'webp';
  }
  return 'png';
}

function isSupportedUploadMime(mimeType = '') {
  return uploadMimeTypes.has(String(mimeType).toLowerCase());
}

function readIntegerEnv(name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === '') {
    return fallback;
  }

  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value)) {
    console.warn(`[config] ${name}=${rawValue} 不是有效数字，使用默认值 ${fallback}`);
    return fallback;
  }

  return Math.max(min, Math.min(max, value));
}

function readListEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function clampInteger(value, { min, max, fallback }) {
  const number = Number(value);
  const safeValue = Number.isFinite(number) ? number : fallback;
  return Math.max(min, Math.min(max, Math.round(safeValue)));
}

function createLimiter(limit) {
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= limit || queue.length === 0) {
      return;
    }

    const job = queue.shift();
    active += 1;
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  };

  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    runNext();
  });
}

function formatRequestError(error) {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return { status: 413, message: maxReferenceImageBytes > 0 ? `单张参考图不能超过 ${formatBytes(maxReferenceImageBytes)}。` : '参考图文件过大，服务端拒绝接收。' };
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return { status: 413, message: `参考图最多 ${maxReferenceImages} 张。` };
    }
    if (error.code === 'LIMIT_FIELD_VALUE') {
      return { status: 413, message: '表单字段过大。' };
    }
    return { status: 400, message: error.message || '上传失败。' };
  }

  const message = error instanceof Error ? error.message : String(error);
  return { status: 400, message: message || '请求处理失败。' };
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / 1024 / 102.4) / 10}MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)}KB`;
  }
  return `${bytes}B`;
}

function setupGracefulShutdown(server) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`[shutdown] received ${signal}, closing server...`);
    for (const task of tasks) {
      if (['pending', 'running'].includes(task.status)) {
        task.status = 'failed';
        task.error = '服务关闭后任务中断，请重试。';
        task.completedAt = new Date().toISOString();
        task.updatedAt = task.completedAt;
        abortTask(task.id);
      }
    }

    for (const client of eventClients) {
      sendEvent(client, 'server-closing', { now: new Date().toISOString() });
      client.end?.();
    }
    eventClients.clear();

    try {
      await persistTasks();
      await closeServer(server);
      process.exit(0);
    } catch (error) {
      console.error('[shutdown:failed]', error);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function startServer(initialPort) {
  let currentPort = initialPort;
  const allowFallback = process.env.NODE_ENV !== 'production';

  while (true) {
    try {
      const server = await listenOnce(currentPort);
      server.requestTimeout = imageApiTimeoutMs + 30000;
      server.headersTimeout = imageApiTimeoutMs + 60000;
      console.log(`Image API Studio running at http://localhost:${currentPort}`);
      if (currentPort !== initialPort) {
        console.log(`Port ${initialPort} was busy, using ${currentPort} instead.`);
      }
      return server;
    } catch (error) {
      if (allowFallback && error?.code === 'EADDRINUSE') {
        currentPort += 1;
        continue;
      }

      throw error;
    }
  }
}

function listenOnce(listenPort) {
  return new Promise((resolve, reject) => {
    const server = app.listen(listenPort, () => resolve(server));
    server.once('error', reject);
  });
}
