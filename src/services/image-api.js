import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getBaseUrl, getApiKey, imageApiTimeoutMs, imageApiRetries, imageApiRetryDelayMs,
  globalImageConcurrency, maxGeneratedImageBytes, generatedDir,
  maxTaskImages, maxTaskConcurrency, getModels, getDefaultModel,
  qualities, backgrounds, formats, maxPromptLength
} from '../config.js';
import {
  createId, createLimiter, sleep, omitAutoFields,
  normalizeApiError, describeFetchError, summarizeText,
  validateReferenceFiles, validateGeneratedImageBuffer, extensionFromMime,
  normalizeSize, clampInteger, isRetryableImageError, isPermanentImageError, formatBytes
} from '../utils.js';
import {
  tasks, findTask, persistTasks, saveReferenceFiles
} from '../storage/index.js';
import { logger } from '../logger.js';

const imageApiLimiter = createLimiter(globalImageConcurrency);
const runningControllers = new Map();

// ── SSE broadcast (injected from outside) ──
let broadcastFn = () => {};
export function setBroadcastFn(fn) { broadcastFn = fn; }

// Patch persistTasks to also broadcast
async function persistAndBroadcast() {
  await persistTasks();
  broadcastFn();
}

// ── Task creation ──
export async function createTask(body, files) {
  const mode = body.mode === 'image' ? 'image' : 'text';
  const prompt = String(body.prompt || '').trim();
  if (prompt.length < 3) throw new Error('请输入至少 3 个字符的提示词。');
  if (prompt.length > maxPromptLength) throw new Error(`提示词不能超过 ${maxPromptLength} 个字符。`);

  validateReferenceFiles(files);
  const sizeResult = normalizeSize(body.size || '1024x1024');
  if (sizeResult.error) throw new Error(sizeResult.error);
  if (mode === 'image' && files.length === 0) throw new Error('图生图请上传至少 1 张参考图。');

  const count = clampInteger(body.count || body.n, { min: 1, max: maxTaskImages, fallback: 1 });
  const concurrency = clampInteger(body.concurrency || body.requestConcurrency, {
    min: 1, max: Math.min(maxTaskConcurrency, count), fallback: 1
  });
  const outputFormatCandidate = String(body.output_format || body.outputFormat || '');
  const outputFormat = formats.has(outputFormatCandidate) ? outputFormatCandidate : 'png';
  const qualityCandidate = String(body.quality || '');
  const backgroundCandidate = String(body.background || '');
  const models = getModels();
  const defaultModel = getDefaultModel();
  const modelCandidate = String(body.model || '');
  const model = models.includes(modelCandidate) ? modelCandidate : defaultModel;
  const now = new Date().toISOString();
  const id = createId();
  const referenceImages = await saveReferenceFiles(id, files);

  return {
    id, mode, prompt, model, size: sizeResult.value,
    quality: qualities.has(qualityCandidate) ? qualityCandidate : 'auto',
    background: backgrounds.has(backgroundCandidate) ? backgroundCandidate : 'auto',
    outputFormat, count, concurrency, status: 'pending', error: '', images: [],
    referenceImages, progress: { done: 0, total: count },
    createdAt: now, updatedAt: now, startedAt: '', completedAt: ''
  };
}

// ── Task processing ──
export async function processTask(taskId) {
  const task = findTask(taskId);
  if (!task || task.status !== 'pending') return;

  task.status = 'running';
  task.error = '';
  task.startedAt = new Date().toISOString();
  task.updatedAt = task.startedAt;
  await persistAndBroadcast();

  try {
    await generateTaskImages(task, task.count);
    const currentTask = findTask(taskId);
    if (!currentTask || currentTask.status === 'canceled') return;
    currentTask.status = currentTask.images.length === currentTask.count ? 'succeeded' : 'canceled';
    currentTask.completedAt = new Date().toISOString();
    currentTask.updatedAt = currentTask.completedAt;
    await persistAndBroadcast();
  } catch (error) {
    const currentTask = findTask(taskId);
    if (!currentTask || currentTask.status === 'canceled') return;
    currentTask.status = 'failed';
    currentTask.error = error instanceof Error ? error.message : String(error);
    currentTask.completedAt = new Date().toISOString();
    currentTask.updatedAt = currentTask.completedAt;
    logger.error('task', 'failed', { taskId, error: currentTask.error });
    await persistAndBroadcast();
  } finally {
    runningControllers.delete(taskId);
  }
}

export async function generateTaskImages(task, total) {
  const pendingIndexes = Array.from({ length: total }, (_, i) => i);
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
    if (['canceled', 'failed'].includes(currentTask.status)) return;
    const image = await generateSingleImage(currentTask, index);
    const liveTask = findTask(task.id);
    if (!liveTask || ['canceled', 'failed'].includes(liveTask.status)) {
      await fs.rm(path.join(generatedDir, image.filename), { force: true }).catch(() => {});
      return;
    }
    liveTask.images.push(image);
    liveTask.progress.done = liveTask.images.length;
    liveTask.updatedAt = new Date().toISOString();
    await persistAndBroadcast();
  }
}

async function generateSingleImage(task, index) {
  const startedAt = Date.now();
  const payload = buildImagePayload(task);
  const result = await callImageApiWithRetry(task.id, payload, task.referenceImages);
  const item = result.data?.[0];
  if (!item?.b64_json && !item?.url) {
    const keys = Object.keys(result).join(', ');
    const dataInfo = result.data ? (Array.isArray(result.data) ? `data[0] keys: ${Object.keys(result.data[0] || {}).join(', ')}` : `data type: ${typeof result.data}`) : 'no data field';
    throw new Error(`接口没有返回图片数据。返回结构: {${keys}}, ${dataInfo}`);
  }

  const mimeType = `image/${task.outputFormat === 'auto' ? 'png' : task.outputFormat}`;
  const buffer = item.b64_json
    ? decodeBase64Image(item.b64_json)
    : await downloadImageUrl(task.id, item.url);
  validateGeneratedImageBuffer(buffer);
  const extension = extensionFromMime(mimeType);
  const filename = `${task.id}-${index + 1}.${extension}`;
  await fs.writeFile(path.join(generatedDir, filename), buffer);

  logger.info('generate', 'success', { taskId: task.id, size: task.size, model: task.model, elapsedMs: Date.now() - startedAt });

  return {
    id: `${task.id}-${index + 1}`, filename, url: `/generated/${filename}`,
    mimeType, revisedPrompt: item.revised_prompt || '', createdAt: new Date().toISOString()
  };
}

function buildImagePayload(task) {
  const payload = { model: task.model, prompt: task.prompt, size: task.size, quality: task.quality, background: task.background, n: 1 };
  if (task.outputFormat !== 'auto') payload.output_format = task.outputFormat;
  return payload;
}

// ── API call with retry ──
async function callImageApiWithRetry(taskId, payload, referenceImages = []) {
  let lastError;
  for (let attempt = 1; attempt <= imageApiRetries + 1; attempt++) {
    if (findTask(taskId)?.status === 'canceled') throw new Error('任务已取消。');
    try {
      return await imageApiLimiter(async () => {
        if (findTask(taskId)?.status === 'canceled') throw new Error('任务已取消。');
        return callImageApi(taskId, payload, referenceImages);
      });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (isPermanentImageError(message)) {
        logger.warn('generate', 'permanent failure', { taskId, attempt, error: message });
        throw error;
      }
      if (attempt <= imageApiRetries && isRetryableImageError(message)) {
        logger.warn('generate', 'retry', { taskId, attempt, nextAttempt: attempt + 1, error: message });
        await sleep(imageApiRetryDelayMs * attempt);
      } else {
        throw error;
      }
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
      for (const [key, value] of Object.entries(editPayload)) formData.set(key, String(value));
      for (const image of referenceImages) {
        const blob = new Blob([await fs.readFile(image.path)], { type: image.mimeType });
        formData.append('image', blob, image.filename);
      }
      response = await fetch(`${getBaseUrl()}/images/edits`, {
        method: 'POST', headers: { Authorization: `Bearer ${getApiKey()}` },
        body: formData, signal: controller.signal
      });
    } else {
      response = await fetch(`${getBaseUrl()}/images/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getApiKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(omitAutoFields(payload)), signal: controller.signal
      });
    }
    const contentType = response.headers.get('content-type') || '';
    const result = contentType.includes('application/json') ? await response.json() : { error: summarizeText(await response.text()) };
    logger.info('image-api', 'response', { taskId, status: response.status, hasData: !!result.data, resultKeys: Object.keys(result), error: result.error ? JSON.stringify(result.error).slice(0, 200) : null });
    if (!response.ok) throw new Error(normalizeApiError(result));
    if (Object.prototype.hasOwnProperty.call(result, 'error') && !result.data) {
      throw new Error(normalizeApiError(result));
    }
    return result;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(findTask(taskId)?.status === 'canceled' ? '任务已取消。' : '图片生成超时。可以稍后重试，或降低尺寸/质量后再生成。');
    }
    if (error instanceof Error && error.message !== 'fetch failed') throw error;
    throw new Error(`调用图片 API 失败：${describeFetchError(error)}`);
  } finally {
    clearTimeout(timeoutId);
    unregisterController(taskId, controller);
  }
}

// ── Image download ──
function decodeBase64Image(base64) {
  const buffer = Buffer.from(String(base64 || ''), 'base64');
  validateGeneratedImageBuffer(buffer);
  return buffer;
}

async function downloadImageUrl(taskId, url) {
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { throw new Error('接口返回的图片 URL 不合法。'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('接口返回的图片 URL 协议不受支持。');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), imageApiTimeoutMs);
  registerController(taskId, controller);

  try {
    const response = await fetch(parsedUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`下载图片失败，HTTP ${response.status}。`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxGeneratedImageBytes) throw new Error(`生成图片超过 ${formatBytes(maxGeneratedImageBytes)}，已拒绝保存。`);
    return await readResponseBuffer(response, maxGeneratedImageBytes);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(findTask(taskId)?.status === 'canceled' ? '任务已取消。' : '下载生成图片超时。');
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
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new Error(`生成图片超过 ${formatBytes(maxBytes)}，已拒绝保存。`); }
    chunks.push(Buffer.from(value));
  }
  const buffer = Buffer.concat(chunks, total);
  validateGeneratedImageBuffer(buffer);
  return buffer;
}

// ── Abort controllers ──
export function abortTask(taskId) {
  const controllers = runningControllers.get(taskId);
  if (!controllers) return;
  for (const c of controllers) c.abort();
  runningControllers.delete(taskId);
}

function registerController(taskId, controller) {
  const controllers = runningControllers.get(taskId) || new Set();
  controllers.add(controller);
  runningControllers.set(taskId, controllers);
}

function unregisterController(taskId, controller) {
  const controllers = runningControllers.get(taskId);
  if (!controllers) return;
  controllers.delete(controller);
  if (!controllers.size) runningControllers.delete(taskId);
}
