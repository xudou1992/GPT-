import { Router } from 'express';
import { defaultModel, models, sizes, qualities, backgrounds, formats, maxTaskImages, maxTaskConcurrency, maxReferenceImages, maxReferenceImageBytes, maxReferenceTotalBytes, maxPromptLength, maxEdge, maxPixels, promptAssistantModel, promptAssistantProvider, promptAssistantApiKey, allowRegistration, getBaseUrl, getApiKey } from '../config.js';
import { tasks, users } from '../storage/index.js';
import { isAuthenticated, isAdmin, getSessionUser } from '../middleware/auth.js';

const router = Router();

router.get('/health', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    configured: Boolean(getApiKey()),
    model: defaultModel,
    tasks: tasks.length,
    uptimeSeconds: Math.round(process.uptime()),
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    nodeVersion: process.version
  });
});

router.get('/config', (req, res) => {
  const sessionUser = getSessionUser(req);
  res.json({
    model: defaultModel, promptAssistantModel, promptAssistantProvider, models, sizes,
    qualities: [...qualities], backgrounds: [...backgrounds], formats: [...formats],
    maxTaskImages, maxTaskConcurrency, maxReferenceImages, maxReferenceImageBytes, maxReferenceTotalBytes, maxPromptLength,
    promptAssistantEnabled: Boolean(promptAssistantApiKey),
    apiBaseUrl: getBaseUrl(),
    maxImageEdge: maxEdge, maxImagePixels: maxPixels,
    configured: Boolean(getApiKey()),
    configurationHints: buildConfigurationHints(),
    authRequired: true, authenticated: isAuthenticated(req), isAdmin: isAdmin(req),
    currentUser: sessionUser || null, allowRegistration,
    registrationCodeRequired: true, hasUsers: users.length > 0
  });
});

function buildConfigurationHints() {
  const hints = [];
  if (!getApiKey()) hints.push('未配置 API Key');
  if (!getBaseUrl()) hints.push('未配置 API 节点');
  if (defaultModel !== 'gpt-image-2') hints.push('当前仅建议使用 gpt-image-2');
  return hints;
}

export default router;
