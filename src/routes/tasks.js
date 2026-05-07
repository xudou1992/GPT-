import { Router } from 'express';
import multer from 'multer';
import { maxReferenceImages, maxReferenceImageBytes, taskStatuses, taskModes, getApiKey } from '../config.js';
import { isSupportedUploadMime, createId, sortTasks } from '../utils.js';
import { logger } from '../logger.js';
import { tasks, findTask, publicTask, persistTasks, deleteTaskFiles, copyReferenceFiles } from '../storage/index.js';
import { createTask, processTask, abortTask } from '../services/image-api.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: maxReferenceImages, fieldSize: 1024 * 1024 },
  fileFilter(_req, file, callback) {
    if (!isSupportedUploadMime(file.mimetype)) {
      callback(new Error('参考图仅支持 PNG、JPEG 或 WebP 图片。'));
      return;
    }
    callback(null, true);
  }
});

const router = Router();

router.get('/', (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1);
  const pageSize = Math.max(1, Math.min(Number.parseInt(req.query.pageSize || '1', 10) || 1, 50));
  const status = taskStatuses.has(req.query.status) ? req.query.status : 'all';
  const mode = taskModes.has(req.query.mode) ? req.query.mode : 'all';

  const filtered = sortTasks(tasks).filter(task => {
    const statusMatch = status === 'all' || (status === 'active' && ['pending', 'running'].includes(task.status)) || task.status === status;
    const modeMatch = mode === 'all' || task.mode === mode;
    return statusMatch && modeMatch;
  });

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;

  res.json({
    tasks: filtered.slice(start, start + pageSize).map(publicTask),
    pagination: { page: safePage, pageSize, total, totalPages }
  });
});

router.post('/', upload.array('referenceImages', maxReferenceImages), async (req, res) => {
  if (!getApiKey()) return res.status(500).json({ error: '服务端还没有配置 OPENAI_API_KEY。' });
  const body = req.is('multipart/form-data') ? req.body : req.body || {};
  const files = req.files || [];
  try {
    const task = await createTask(body, files);
    tasks.unshift(task);
    await persistTasks();
    logger.info('task', 'created', { taskId: task.id, mode: task.mode, count: task.count });
    processTask(task.id).catch(error => logger.error('task', 'unhandled processing error', { taskId: task.id, error }));
    res.status(201).json({ task: publicTask(task) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/:id/cancel', async (req, res) => {
  const task = findTask(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在。' });
  if (!['pending', 'running'].includes(task.status)) return res.status(400).json({ error: '只有等待中或生成中的任务可以取消。' });
  task.status = 'canceled';
  task.completedAt = new Date().toISOString();
  task.updatedAt = task.completedAt;
  abortTask(task.id);
  await persistTasks();
  res.json({ task: publicTask(task) });
});

router.post('/:id/retry', async (req, res) => {
  const source = findTask(req.params.id);
  if (!source) return res.status(404).json({ error: '任务不存在。' });
  if (['pending', 'running'].includes(source.status)) return res.status(400).json({ error: '任务正在执行，不能重试。' });

  const newId = createId();
  // 图生图任务需要复制参考图到新目录
  let referenceImages = [];
  if (source.referenceImages?.length) {
    referenceImages = await copyReferenceFiles(newId, source.referenceImages);
    if (referenceImages.length === 0) {
      return res.status(400).json({ error: '参考图文件已丢失，无法重试。请重新创建任务。' });
    }
  }

  const task = {
    ...source, id: newId, status: 'pending', error: '', images: [],
    referenceImages,
    progress: { done: 0, total: source.count },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    startedAt: '', completedAt: '', retryOf: source.id
  };
  tasks.unshift(task);
  await persistTasks();
  logger.info('task', 'retry created', { taskId: task.id, retryOf: source.id });
  processTask(task.id).catch(error => logger.error('task', 'unhandled processing error', { taskId: task.id, error }));
  res.status(201).json({ task: publicTask(task) });
});

router.delete('/batch/:status', async (req, res) => {
  const validStatuses = ['succeeded', 'failed', 'canceled'];
  const status = req.params.status;
  if (!validStatuses.includes(status)) return res.status(400).json({ error: '只能批量删除已完成、失败或已取消的任务。' });
  const toDelete = tasks.filter(t => t.status === status);
  if (toDelete.length === 0) return res.json({ deleted: 0 });
  for (const task of toDelete) {
    const idx = tasks.indexOf(task);
    if (idx !== -1) tasks.splice(idx, 1);
    await deleteTaskFiles(task);
  }
  await persistTasks();
  logger.info('task', 'batch deleted', { status, count: toDelete.length });
  res.json({ deleted: toDelete.length });
});

router.delete('/:id', async (req, res) => {
  const index = tasks.findIndex(task => task.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: '任务不存在。' });
  const [task] = tasks.splice(index, 1);
  await deleteTaskFiles(task);
  await persistTasks();
  res.status(204).end();
});

export { upload };
export default router;
