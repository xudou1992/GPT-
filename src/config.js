import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
export const envFile = path.join(rootDir, '.env');

// ── Helpers ──
function readIntegerEnv(name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === '') return fallback;
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value)) {
    console.warn(`[config] ${name}=${rawValue} 不是有效数字，使用默认值 ${fallback}`);
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function readListEnv(name) {
  return String(process.env[name] || '').split(',').map(v => v.trim()).filter(Boolean);
}

// ── Server ──
export const port = readIntegerEnv('PORT', 3000, { min: 1, max: 65535 });

// ── Image API ──
export const apiBasePresets = [
  { label: '新 CDN 节点', value: 'https://cdn.jucode.cn/v1' },
  { label: '亚太 CDN 节点', value: 'https://cdn.jucode.top/v1' },
  { label: '海外 CF 节点', value: 'https://cf.jucode.top/v1' },
  { label: '海外 API 节点', value: 'https://api.jucode.cn/v1' }
];
let runtimeBaseUrl = normalizeBaseUrl(process.env.OPENAI_BASE_URL || apiBasePresets[0].value);
process.env.OPENAI_BASE_URL = runtimeBaseUrl;
export let baseUrl = runtimeBaseUrl;
export function getBaseUrl() { return runtimeBaseUrl; }
export function isValidApiBaseUrl(value) {
  try {
    normalizeBaseUrl(value);
    return true;
  } catch {
    return false;
  }
}
export function setBaseUrl(value) {
  runtimeBaseUrl = normalizeBaseUrl(value);
  baseUrl = runtimeBaseUrl;
  process.env.OPENAI_BASE_URL = runtimeBaseUrl;
  return runtimeBaseUrl;
}
export function normalizeBaseUrl(value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) throw new Error('OPENAI_BASE_URL 不能为空。');
  let url;
  try { url = new URL(rawValue); }
  catch { throw new Error('OPENAI_BASE_URL 必须是合法的 http(s) 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('OPENAI_BASE_URL 仅支持 http 或 https。');
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
  return url.toString().replace(/\/$/, '');
}

// ── Custom API Key (runtime override) ──
let customApiKey = '';
export function getApiKey() {
  return customApiKey || process.env.OPENAI_API_KEY || '';
}
export function setCustomApiKey(value) {
  customApiKey = String(value || '').trim();
  return customApiKey;
}
let runtimeDefaultModel = String(process.env.IMAGE_MODEL || 'gpt-image-2').trim() || 'gpt-image-2';
process.env.IMAGE_MODEL = runtimeDefaultModel;

export let defaultModel = runtimeDefaultModel;
export function getDefaultModel() { return runtimeDefaultModel; }
export function getCustomApiKey() { return customApiKey; }
export function setDefaultModel(value) {
  const model = String(value || '').trim();
  if (!model) throw new Error('IMAGE_MODEL 不能为空。');
  if (model !== 'gpt-image-2') throw new Error('当前仅允许使用 gpt-image-2。');
  runtimeDefaultModel = model;
  defaultModel = runtimeDefaultModel;
  models = getModels();
  process.env.IMAGE_MODEL = runtimeDefaultModel;
  return runtimeDefaultModel;
}
export function getModels() {
  return [runtimeDefaultModel];
}

// Default to 15 minutes for slow image models/upstreams.
export const imageApiTimeoutMs = readIntegerEnv('IMAGE_API_TIMEOUT_MS', 900000, { min: 5000, max: 1800000 });
export const imageApiRetries = readIntegerEnv('IMAGE_API_RETRIES', 2, { min: 0, max: 3 });
export const imageApiRetryDelayMs = readIntegerEnv('IMAGE_API_RETRY_DELAY_MS', 1000, { min: 100, max: 10000 });
export const maxTaskImages = readIntegerEnv('MAX_TASK_IMAGES', 50, { min: 1, max: 500 });
export const maxTaskConcurrency = readIntegerEnv('MAX_TASK_CONCURRENCY', 10, { min: 1, max: 100 });
export const globalImageConcurrency = readIntegerEnv('IMAGE_API_GLOBAL_CONCURRENCY', maxTaskConcurrency, { min: 1, max: 100 });
export const maxPromptLength = readIntegerEnv('MAX_PROMPT_LENGTH', 4000, { min: 3, max: 20000 });
export const maxReferenceImages = readIntegerEnv('MAX_REFERENCE_IMAGES', 10, { min: 1, max: 20 });
export const maxReferenceImageBytes = readIntegerEnv('MAX_REFERENCE_IMAGE_BYTES', 0, { min: 0 });
export const maxReferenceTotalBytes = readIntegerEnv('MAX_REFERENCE_TOTAL_BYTES', 0, { min: 0 });
export const maxGeneratedImageBytes = readIntegerEnv('MAX_GENERATED_IMAGE_BYTES', 80 * 1024 * 1024, { min: 1024, max: 500 * 1024 * 1024 });

// ── Prompt Assistant ──
export const promptAssistantProvider = process.env.PROMPT_ASSISTANT_PROVIDER || 'openrouter';
export function getPromptAssistantBaseUrl() {
  return (
    process.env.PROMPT_ASSISTANT_BASE_URL ||
    (promptAssistantProvider === 'openrouter' ? 'https://openrouter.ai/api/v1' : getBaseUrl())
  ).replace(/\/$/, '');
}
export const promptAssistantBaseUrl = getPromptAssistantBaseUrl();
export const promptAssistantApiKey = process.env.PROMPT_ASSISTANT_API_KEY
  || (promptAssistantProvider === 'openrouter' ? process.env.OPENROUTER_API_KEY || '' : process.env.OPENAI_API_KEY || '');
export const promptAssistantModel = process.env.PROMPT_ASSISTANT_MODEL
  || (promptAssistantProvider === 'openrouter' ? 'openrouter/free' : 'gpt-4o-mini');
export const promptAssistantTimeoutMs = readIntegerEnv('PROMPT_ASSISTANT_TIMEOUT_MS', 60000, { min: 5000, max: 5 * 60 * 1000 });
export const promptAssistantConcurrency = readIntegerEnv('PROMPT_ASSISTANT_CONCURRENCY', 3, { min: 1, max: 20 });

// ── Auth ──
export const accessPassword = process.env.ACCESS_PASSWORD || '';
export const allowRegistration = (process.env.ALLOW_REGISTRATION || 'true') !== 'false';

// ── Paths ──
export const dataDir = path.join(rootDir, 'data');
export const generatedDir = path.join(rootDir, 'public', 'generated');
export const uploadsDir = path.join(dataDir, 'uploads');
export const thumbsDir = path.join(dataDir, 'thumbs');
export const tasksFile = path.join(dataDir, 'tasks.json');
export const usersFile = path.join(dataDir, 'users.json');
export const invitesFile = path.join(dataDir, 'invites.json');
export const sessionsFile = path.join(dataDir, 'sessions.json');
export const publicDir = path.join(rootDir, 'public');

// ── Models & Sizes ──
export let models = getModels();

export const sizes = ['3840x2160', '2160x3840'];
export const allowedSizes = new Set(sizes);
export const minEdge = 16;
export const maxEdge = readIntegerEnv('MAX_IMAGE_EDGE', 4096, { min: minEdge, max: 16384 });
export const maxPixels = readIntegerEnv('MAX_IMAGE_PIXELS', maxEdge * maxEdge, { min: minEdge * minEdge, max: 16384 * 16384 });

export const qualities = new Set(['auto', 'low', 'medium', 'high']);
export const backgrounds = new Set(['auto', 'transparent', 'opaque']);
export const formats = new Set(['auto', 'png', 'jpeg', 'webp']);
export const taskStatuses = new Set(['all', 'active', 'pending', 'running', 'succeeded', 'failed', 'canceled']);
export const taskModes = new Set(['all', 'text', 'image']);
export const uploadMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

export { readIntegerEnv, readListEnv };
