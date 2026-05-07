import express from 'express';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fsSync from 'node:fs';
import sharp from 'sharp';
import multer from 'multer';

import { port, imageApiTimeoutMs, generatedDir, thumbsDir, publicDir, maxReferenceImageBytes, maxReferenceImages } from './config.js';
import { formatBytes } from './utils.js';
import { logger } from './logger.js';
import { securityHeaders } from './middleware/security.js';
import { requireAccess } from './middleware/auth.js';
import {
  ensureStorage, loadTasksFromDisk, loadUsersFromDisk, loadInvitesFromDisk, loadSessionsFromDisk,
  resetInterruptedTasks, setTasks, setUsers, setInvites, setSessions,
  tasks, persistTasks
} from './storage/index.js';
import { setBroadcastFn, abortTask } from './services/image-api.js';
import { broadcastTasksChanged, closeAllClients } from './routes/sse.js';

import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import tasksRouter from './routes/tasks.js';
import sseRouter from './routes/sse.js';
import apiRouter from './routes/api.js';
import adminRouter from './routes/admin.js';
import apiSettingsRouter from './routes/api-settings.js';

// ── Bootstrap ──
const app = express();

await ensureStorage();
setTasks(await loadTasksFromDisk());
setUsers(await loadUsersFromDisk());
setInvites(await loadInvitesFromDisk());
setSessions(await loadSessionsFromDisk());
await resetInterruptedTasks();

// Wire up broadcast for image-api service
setBroadcastFn(broadcastTasksChanged);

process.on('unhandledRejection', error => logger.error('process', 'unhandled rejection', { error }));
process.on('uncaughtException', error => logger.error('process', 'uncaught exception', { error }));

// ── Middleware ──
app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(securityHeaders);

// ── Thumbnail endpoint (before static) ──
app.get('/generated/thumb/:filename', requireAccess, async (req, res) => {
  const filename = path.basename(req.params.filename);
  const srcPath = path.join(generatedDir, filename);
  const thumbName = filename.replace(/\.[^.]+$/, '.webp');
  const thumbPath = path.join(thumbsDir, thumbName);
  try {
    if (fsSync.existsSync(thumbPath)) {
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      return res.sendFile(thumbPath);
    }
    await import('node:fs/promises').then(fs => fs.access(srcPath));
    await sharp(srcPath).resize(400, 400, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 60 }).toFile(thumbPath);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.sendFile(thumbPath);
  } catch { res.status(404).end(); }
});

// ── Static files ──
app.use('/generated', requireAccess, express.static(generatedDir, {
  etag: true, lastModified: true,
  setHeaders(res) { res.setHeader('Cache-Control', 'public, max-age=604800, immutable'); }
}));
app.use('/assets', express.static(path.join(publicDir, 'assets'), {
  etag: false, lastModified: false,
  setHeaders(res) { res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); }
}));
app.use(express.static(publicDir, {
  etag: true, lastModified: true, maxAge: '10m'
}));

// ── Rate limiters ──
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: '请求过于频繁，请稍后重试。' } });
const taskCreateLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: '创建任务过于频繁，请稍后重试。' } });
const clientErrorLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

// ── Public routes (no auth) ──
app.post('/api/admin/client-errors', clientErrorLimiter, express.json({ limit: '4kb' }), (req, res) => {
  const { type, message, source, lineno, colno, ua } = req.body || {};
  logger.warn('client', String(message || 'unknown').slice(0, 500), { type, source, lineno, colno, ua });
  res.status(204).end();
});
app.use('/api', healthRouter);
app.post('/api/login', authLimiter);
app.post('/api/register', authLimiter);
app.use('/api', authRouter);

// ── Auth wall ──
app.use('/api', requireAccess);

// ── Protected routes ──
app.use('/api/events', sseRouter);
app.post('/api/tasks', taskCreateLimiter);
app.use('/api/tasks', tasksRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin/settings', apiSettingsRouter);
app.use('/api', apiRouter);

// ── Error handler ──
app.use((error, _req, res, _next) => {
  const { status, message } = formatRequestError(error);
  logger.error('request', 'request failed', { status, message });
  res.status(status).json({ error: message });
});

// ── SPA fallback ──
app.get('*', (req, res) => {
  if (path.extname(req.path)) return res.status(404).end();
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ── Start ──
const server = await startServer(port);
setupGracefulShutdown(server);

function formatRequestError(error) {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') return { status: 413, message: maxReferenceImageBytes > 0 ? `单张参考图不能超过 ${formatBytes(maxReferenceImageBytes)}。` : '参考图文件过大，服务端拒绝接收。' };
    if (error.code === 'LIMIT_FILE_COUNT') return { status: 413, message: `参考图最多 ${maxReferenceImages} 张。` };
    if (error.code === 'LIMIT_FIELD_VALUE') return { status: 413, message: '表单字段过大。' };
    return { status: 400, message: error.message || '上传失败。' };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 400, message: message || '请求处理失败。' };
}

function setupGracefulShutdown(server) {
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server', 'shutdown requested', { signal });
    for (const task of tasks) {
      if (['pending', 'running'].includes(task.status)) {
        task.status = 'failed';
        task.error = '服务关闭后任务中断，请重试。';
        task.completedAt = new Date().toISOString();
        task.updatedAt = task.completedAt;
        abortTask(task.id);
      }
    }
    closeAllClients();
    try { await persistTasks(); await closeServer(server); process.exit(0); }
    catch (error) { logger.error('server', 'shutdown failed', { error }); process.exit(1); }
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

function closeServer(server) {
  return new Promise((resolve, reject) => { server.close(err => err ? reject(err) : resolve()); });
}

async function startServer(initialPort) {
  let currentPort = initialPort;
  const allowFallback = process.env.NODE_ENV !== 'production';
  while (true) {
    try {
      const server = await new Promise((resolve, reject) => {
        const s = app.listen(currentPort, () => resolve(s));
        s.once('error', reject);
      });
      server.requestTimeout = imageApiTimeoutMs + 30000;
      server.headersTimeout = imageApiTimeoutMs + 60000;
      logger.info('server', 'started', { port: currentPort });
      if (currentPort !== initialPort) logger.warn('server', 'fallback port selected', { requestedPort: initialPort, port: currentPort });
      return server;
    } catch (error) {
      if (allowFallback && error?.code === 'EADDRINUSE') { currentPort++; continue; }
      throw error;
    }
  }
}
