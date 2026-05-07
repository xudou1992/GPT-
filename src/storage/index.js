import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  dataDir, generatedDir, uploadsDir, thumbsDir,
  tasksFile, usersFile, invitesFile, sessionsFile,
  maxTaskImages, maxTaskConcurrency
} from '../config.js';
import { clampInteger } from '../utils.js';

// ── In-memory state ──
export let tasks = [];
export let users = [];
export let invites = [];
export let sessions = new Map();

let writeChain = Promise.resolve();
let usersWriteChain = Promise.resolve();
let invitesWriteChain = Promise.resolve();
let sessionsWriteChain = Promise.resolve();

// ── Setters (to reassign module-level lets) ──
export function setTasks(val) { tasks = val; }
export function setUsers(val) { users = val; }
export function setInvites(val) { invites = val; }
export function setSessions(val) { sessions = val; }

// ── Directory initialization ──
export async function ensureStorage() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(generatedDir, { recursive: true });
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(thumbsDir, { recursive: true });
  for (const [file, initial] of [[tasksFile, '[]\n'], [usersFile, '[]\n'], [invitesFile, '[]\n'], [sessionsFile, '{}\n']]) {
    if (!fsSync.existsSync(file)) await fs.writeFile(file, initial, 'utf8');
  }
}

// ── Tasks ──
export async function loadTasksFromDisk() {
  try {
    return normalizeLoadedTasks(JSON.parse(await fs.readFile(tasksFile, 'utf8')));
  } catch (error) {
    console.warn('[tasks:load:primary-failed]', error instanceof Error ? error.message : String(error));
  }
  try {
    return normalizeLoadedTasks(JSON.parse(await fs.readFile(`${tasksFile}.bak`, 'utf8')));
  } catch (error) {
    console.warn('[tasks:load:backup-failed]', error instanceof Error ? error.message : String(error));
    return [];
  }
}

function normalizeLoadedTasks(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(task => task && typeof task === 'object' && task.id)
    .map(task => {
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

export function persistTasks() {
  writeChain = writeChain.catch(error => {
    console.error('[tasks:persist:previous-failed]', error instanceof Error ? error.message : String(error));
  }).then(async () => {
    const tempFile = `${tasksFile}.${process.pid}.tmp`;
    const backupFile = `${tasksFile}.bak`;
    const serialized = `${JSON.stringify(tasks, null, 2)}\n`;
    try {
      await fs.writeFile(tempFile, serialized, 'utf8');
      if (fsSync.existsSync(tasksFile)) await fs.copyFile(tasksFile, backupFile);
      await fs.rename(tempFile, tasksFile);
    } catch (error) {
      await fs.rm(tempFile, { force: true }).catch(() => {});
      throw error;
    }
  });
  return writeChain;
}

// ── Users ──
export async function loadUsersFromDisk() {
  try { return JSON.parse(await fs.readFile(usersFile, 'utf8')); }
  catch (error) { console.warn('[users:load:failed]', error instanceof Error ? error.message : String(error)); return []; }
}

export function persistUsers() {
  usersWriteChain = usersWriteChain.catch(() => {}).then(async () => {
    const tempFile = `${usersFile}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tempFile, JSON.stringify(users, null, 2) + '\n', 'utf8');
      await fs.rename(tempFile, usersFile);
    } catch (error) { await fs.rm(tempFile, { force: true }).catch(() => {}); throw error; }
  });
  return usersWriteChain;
}

// ── Invites ──
export async function loadInvitesFromDisk() {
  try { return JSON.parse(await fs.readFile(invitesFile, 'utf8')); }
  catch (error) { console.warn('[invites:load:failed]', error instanceof Error ? error.message : String(error)); return []; }
}

export function persistInvites() {
  invitesWriteChain = invitesWriteChain.catch(() => {}).then(async () => {
    const tempFile = `${invitesFile}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tempFile, JSON.stringify(invites, null, 2), 'utf8');
      await fs.rename(tempFile, invitesFile);
    } catch (error) { console.error('[invites:persist:failed]', error); try { await fs.unlink(tempFile); } catch {} }
  });
  return invitesWriteChain;
}

// ── Sessions ──
export async function loadSessionsFromDisk() {
  try {
    const data = JSON.parse(await fs.readFile(sessionsFile, 'utf8'));
    const map = new Map();
    const now = Date.now();
    const maxAge = 30 * 24 * 60 * 60 * 1000;
    for (const [token, session] of Object.entries(data)) {
      if (session?.createdAt && now - session.createdAt < maxAge) map.set(token, session);
    }
    return map;
  } catch (error) {
    console.warn('[sessions:load:failed]', error instanceof Error ? error.message : String(error));
    return new Map();
  }
}

export function persistSessions() {
  sessionsWriteChain = sessionsWriteChain.catch(() => {}).then(async () => {
    const tempFile = `${sessionsFile}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tempFile, JSON.stringify(Object.fromEntries(sessions), null, 2), 'utf8');
      await fs.rename(tempFile, sessionsFile);
    } catch (error) { console.error('[sessions:persist:failed]', error); try { await fs.unlink(tempFile); } catch {} }
  });
  return sessionsWriteChain;
}

export async function readEnvFile() {
  try {
    return await fs.readFile(path.join(path.dirname(dataDir), '.env'), 'utf8');
  } catch {
    return '';
  }
}

export async function writeEnvFile(content) {
  await fs.writeFile(path.join(path.dirname(dataDir), '.env'), content, 'utf8');
}

// ── File operations ──
export async function saveReferenceFiles(taskId, files) {
  if (!files.length) return [];
  const taskUploadDir = path.join(uploadsDir, taskId);
  await fs.mkdir(taskUploadDir, { recursive: true });
  const saved = [];
  for (const [index, file] of files.entries()) {
    const { extensionFromMime } = await import('../utils.js');
    const extension = extensionFromMime(file.mimetype) || path.extname(file.originalname).replace('.', '') || 'png';
    const filename = `reference-${index + 1}.${extension}`;
    const absolutePath = path.join(taskUploadDir, filename);
    await fs.writeFile(absolutePath, file.buffer);
    saved.push({ filename, path: absolutePath, mimeType: file.mimetype, size: file.size });
  }
  return saved;
}

export async function copyReferenceFiles(newTaskId, sourceReferenceImages) {
  if (!sourceReferenceImages?.length) return [];
  const newDir = path.join(uploadsDir, newTaskId);
  await fs.mkdir(newDir, { recursive: true });
  const copied = [];
  for (const ref of sourceReferenceImages) {
    const dest = path.join(newDir, ref.filename);
    try {
      await fs.copyFile(ref.path, dest);
      copied.push({ ...ref, path: dest });
    } catch {
      // 源文件不存在则跳过
    }
  }
  return copied;
}

export async function deleteTaskFiles(task) {
  await Promise.allSettled([
    ...task.images.map(image => fs.rm(path.join(generatedDir, image.filename), { force: true })),
    ...task.images.map(image => fs.rm(path.join(thumbsDir, image.filename.replace(/\.[^.]+$/, '.webp')), { force: true })),
    fs.rm(path.join(uploadsDir, task.id), { recursive: true, force: true })
  ]);
}

export async function resetInterruptedTasks() {
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
  if (changed) await persistTasks();
}

export function findTask(id) {
  return tasks.find(task => task.id === id);
}

export function publicTask(task) {
  return {
    id: task.id, mode: task.mode, prompt: task.prompt, model: task.model,
    size: task.size, quality: task.quality, background: task.background,
    outputFormat: task.outputFormat, count: task.count, concurrency: task.concurrency,
    status: task.status, error: task.error, images: task.images, progress: task.progress,
    referenceImageCount: task.referenceImages?.length || 0, retryOf: task.retryOf,
    createdAt: task.createdAt, updatedAt: task.updatedAt,
    startedAt: task.startedAt, completedAt: task.completedAt
  };
}
