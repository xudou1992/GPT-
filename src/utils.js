import crypto from 'node:crypto';
import {
  maxGeneratedImageBytes, maxReferenceImageBytes, maxReferenceTotalBytes,
  maxReferenceImages, allowedSizes, minEdge, maxEdge, maxPixels,
  uploadMimeTypes
} from './config.js';

export function createId() {
  return crypto.randomBytes(10).toString('hex');
}

export function createSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function createAccessToken(password) {
  return crypto.createHash('sha256').update(`image-api-studio:${password}`).digest('hex');
}

export function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

export function getCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [rawKey, ...rawValue] = cookie.trim().split('=');
    if (rawKey === name) return decodeURIComponent(rawValue.join('='));
  }
  return '';
}

export function isHttps(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

export function normalizeSize(value) {
  const size = String(value || '').trim().toLowerCase();
  if (allowedSizes.has(size)) return { value: size };
  if (!size) return { value: '1024x1024' };

  const match = size.match(/^(\d{2,4})x(\d{2,4})$/);
  if (!match) return { error: '尺寸格式不正确，请使用 WIDTHxHEIGHT，例如 1024x1024。' };

  const width = Number(match[1]);
  const height = Number(match[2]);
  const error = validateSize(width, height);
  return error ? { error } : { value: `${width}x${height}` };
}

function validateSize(width, height) {
  const pixels = width * height;
  if (width % 16 !== 0 || height % 16 !== 0) return '尺寸宽高必须是 16 的倍数。';
  if (width < minEdge || height < minEdge) return `尺寸宽高不能小于 ${minEdge}。`;
  if (Math.max(width, height) > maxEdge) return `尺寸最长边不能超过 ${maxEdge}。`;
  if (pixels > maxPixels) return `尺寸总像素不能超过 ${maxPixels}。`;
  return '';
}

export function validateReferenceFiles(files = []) {
  if (files.length > maxReferenceImages) throw new Error(`参考图最多 ${maxReferenceImages} 张。`);
  let totalBytes = 0;
  for (const file of files) {
    if (!isSupportedUploadMime(file.mimetype)) throw new Error('参考图仅支持 PNG、JPEG 或 WebP。');
    totalBytes += file.size || 0;
    if (maxReferenceImageBytes > 0 && (file.size || 0) > maxReferenceImageBytes) {
      throw new Error(`单张参考图不能超过 ${formatBytes(maxReferenceImageBytes)}。`);
    }
  }
  if (maxReferenceTotalBytes > 0 && totalBytes > maxReferenceTotalBytes) {
    throw new Error(`参考图总大小不能超过 ${formatBytes(maxReferenceTotalBytes)}。`);
  }
}

export function validateGeneratedImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('接口返回的图片数据为空。');
  if (buffer.length > maxGeneratedImageBytes) {
    throw new Error(`生成图片超过 ${formatBytes(maxGeneratedImageBytes)}，已拒绝保存。`);
  }
}

export function isSupportedUploadMime(mimeType = '') {
  return uploadMimeTypes.has(String(mimeType).toLowerCase());
}

export function extensionFromMime(mimeType = 'image/png') {
  if (mimeType.includes('jpeg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  return 'png';
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 102.4) / 10}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

export function summarizeText(text) {
  return String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) || '上游接口返回了非 JSON 响应。';
}

export function normalizeApiError(result) {
  const code = String(
    result?.code || result?.error?.code || result?.error?.type || result?.type || ''
  ).trim();
  const rawMessage =
    typeof result?.error === 'string'
      ? result.error
      : (result?.error?.message || result?.message || '');
  const message = String(rawMessage || '').trim();

  if (
    /(?:error\s*code\s*524|524:\s*a timeout occurred)/i.test(message)
    || (/cloudflare/i.test(message) && /host error/i.test(message))
  ) {
    return '上游节点响应超时（Cloudflare 524），请稍后重试，或切换到其他 API 节点。';
  }

  if (/no available channel for model/i.test(message)) {
    return '当前节点未开通 gpt-image-2 生图通道，请在 API 节点设置里切换节点，或确认中转后台已给该 Key 分配生图分组。';
  }

  if (/令牌未配置可用分组|未配置可用分组/i.test(message)) {
    return '当前 API Key 没有配置可用分组，请到中转后台给这个 Key 分配支持 gpt-image-2 的生图分组。';
  }

  if (/额度不足|insufficient.*quota|剩余额度\s*[:：]?\s*[＄$]?0/i.test(message) || /insufficient.*quota/i.test(code)) {
    return '当前 API Key 额度不足，生图无法继续。请给中转账号充值或在 API 节点设置里换一个有额度的 Key。';
  }

  if (/image_auth_busy|eligible image generation auths are busy|credentials?.*cooling down/i.test(`${code} ${message}`)) {
    return '上游生图账号繁忙或冷却中，请稍后重试，或切换到其他可用节点/Key。';
  }

  return message || '图片 API 返回了错误，请查看 details。';
}

export function isPermanentImageError(message) {
  return /额度不足|insufficient.*quota|令牌未配置可用分组|未配置可用分组|no available channel for model|未开通.*生图通道|API Key 没有配置可用分组/i.test(String(message || ''));
}

export function describeFetchError(error) {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  if (error.cause?.code) parts.push(`code=${error.cause.code}`);
  if (error.cause?.message) parts.push(`cause=${error.cause.message}`);
  return parts.join('; ');
}

export function clampInteger(value, { min, max, fallback }) {
  const number = Number(value);
  const safeValue = Number.isFinite(number) ? number : fallback;
  return Math.max(min, Math.min(max, Math.round(safeValue)));
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createLimiter(limit) {
  let active = 0;
  const queue = [];
  const runNext = () => {
    if (active >= limit || queue.length === 0) return;
    const job = queue.shift();
    active += 1;
    Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { active -= 1; runNext(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); runNext(); });
}

export function sortTasks(taskList) {
  return [...taskList].sort((left, right) =>
    Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt)
  );
}

export function omitAutoFields(payload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([_key, value]) => value !== 'auto' && value !== '' && value !== undefined)
  );
}

export function isRetryableImageError(message) {
  const text = String(message || '');
  if (isPermanentImageError(text)) return false;
  return /fetch failed|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET|other side closed|Connect Timeout|Headers Timeout|ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|HTTP\s*5\d\d|timeout|Cloudflare 524|image_auth_busy|eligible image generation auths are busy|credentials?.*cooling down/i.test(text);
}
