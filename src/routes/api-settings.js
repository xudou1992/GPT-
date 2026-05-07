import { Router } from 'express';
import fs from 'node:fs/promises';
import { apiBasePresets, getBaseUrl, getDefaultModel, getModels, setDefaultModel, getApiKey, getCustomApiKey, isValidApiBaseUrl, normalizeBaseUrl, setBaseUrl, setCustomApiKey, envFile } from '../config.js';
import { requireAdmin } from '../middleware/auth.js';
import { readEnvFile } from '../storage/index.js';
import { logger } from '../logger.js';
import { normalizeApiError, summarizeText } from '../utils.js';

const router = Router();
router.use(requireAdmin);

router.get('/api-base', (_req, res) => {
  res.json({
    current: getBaseUrl(),
    presets: apiBasePresets,
    currentModel: getDefaultModel()
  });
});

router.post('/api-base/test', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const model = String(req.body?.model || getDefaultModel()).trim() || getDefaultModel();
  const testKey = String(req.body?.key || '').trim() || getApiKey();
  try {
    const baseUrl = normalizeBaseUrl(url);
    const startedAt = Date.now();

    if (!testKey) {
      return res.json({
        ok: false, status: 0, elapsedMs: 0,
        modelSupported: false, message: '服务端还没有配置 API Key。'
      });
    }

    // Step 1: 快速连通性测试
    const pingRes = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${testKey}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!pingRes.ok) {
      const text = await pingRes.text();
      return res.json({
        ok: false, status: pingRes.status, elapsedMs: Date.now() - startedAt,
        modelSupported: false, message: summarizeText(text)
      });
    }

    // Step 2: 实际图片生成兼容性测试（用小图、简单 prompt）
    const testPrompt = 'red circle';
    const genRes = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${testKey}` },
      body: JSON.stringify({ model, prompt: testPrompt, size: '1024x1024', n: 1 }),
      signal: AbortSignal.timeout(120000)
    });
    const contentType = genRes.headers.get('content-type') || '';
    const genText = await genRes.text();
    let genJson = null;
    try { genJson = contentType.includes('application/json') ? JSON.parse(genText) : null; } catch {}
    const normalizedMessage = genJson ? normalizeApiError(genJson) : summarizeText(genText);

    const isModelError = genText.toLowerCase().includes('no available channel')
      || genText.toLowerCase().includes('not supported')
      || genText.toLowerCase().includes('model')
      || (genJson?.error?.message || '').toLowerCase().includes('model');

    res.json({
      ok: genRes.ok && !isModelError,
      status: genRes.status,
      elapsedMs: Date.now() - startedAt,
      modelSupported: !isModelError && genRes.ok,
      model,
      message: genRes.ok ? '' : normalizedMessage
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/api-base', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!isValidApiBaseUrl(url)) return res.status(400).json({ error: 'API 地址不合法。' });
  const baseUrl = setBaseUrl(url);
  const envText = await readEnvFile();
  const lines = envText.split(/\r?\n/).filter(line => line && !line.startsWith('OPENAI_BASE_URL='));
  lines.push(`OPENAI_BASE_URL=${baseUrl}`);
  await fs.writeFile(envFile, `${lines.join('\n')}\n`, 'utf8');
  logger.info('config', 'api base updated', { baseUrl });
  res.json({ ok: true, baseUrl });
});

// ── Model ──
router.get('/models', (_req, res) => {
  res.json({
    current: getDefaultModel(),
    models: getModels()
  });
});

router.post('/models', async (req, res) => {
  const defaultModel = String(req.body?.defaultModel || req.body?.default || '').trim();
  if (!defaultModel) return res.status(400).json({ error: '模型名称不能为空。' });
  if (defaultModel !== 'gpt-image-2') return res.status(400).json({ error: '当前仅允许使用 gpt-image-2。' });
  try {
    const envText = await readEnvFile();
    const lines = envText
      .split(/\r?\n/)
      .filter(line => line && !line.startsWith('IMAGE_MODEL=') && !line.startsWith('IMAGE_MODELS='));
    lines.push(`IMAGE_MODEL=${defaultModel}`);
    await fs.writeFile(envFile, `${lines.join('\n')}\n`, 'utf8');
    setDefaultModel(defaultModel);
    process.env.IMAGE_MODELS = '';
    logger.info('config', 'image model updated', { defaultModel });
    res.json({ ok: true, defaultModel, models: [defaultModel] });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ── API Key ──
router.get('/api-key', (_req, res) => {
  res.json({
    current: getCustomApiKey(),
    hasCustom: !!getCustomApiKey(),
    envKeyPrefix: (process.env.OPENAI_API_KEY || '').slice(0, 10) + '...'
  });
});

router.post('/api-key', async (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (key.length > 0 && !key.startsWith('sk-')) {
    return res.status(400).json({ error: 'API Key 格式不正确，应以 sk- 开头。' });
  }
  setCustomApiKey(key);
  if (key) {
    const envText = await readEnvFile();
    const lines = envText.split(/\r?\n/).filter(line => line && !line.startsWith('OPENAI_API_KEY='));
    lines.push(`OPENAI_API_KEY=${key}`);
    await fs.writeFile(envFile, `${lines.join('\n')}\n`, 'utf8');
    logger.info('config', 'api key updated');
  }
  res.json({ ok: true, hasCustom: !!key });
});

export default router;
