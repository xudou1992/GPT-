import { Router } from 'express';
import { promptAssistantApiKey, getApiKey } from '../config.js';
import { createTask, processTask } from '../services/image-api.js';
import { tasks, persistTasks, publicTask } from '../storage/index.js';
import { logger } from '../logger.js';
import { createPromptSuggestion } from '../services/prompt-assistant.js';

const router = Router();

router.post('/prompt-assistant', async (req, res) => {
  if (!promptAssistantApiKey) return res.status(500).json({ error: '服务端还没有配置提示词助手 API Key。' });
  try {
    const result = await createPromptSuggestion(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/generate', async (req, res) => {
  if (!getApiKey()) {
    return res.status(500).json({ error: '服务端还没有配置 OPENAI_API_KEY。' });
  }

  try {
    const body = req.body || {};
    const task = await createTask({ ...body, count: body.n || body.count }, []);
    tasks.unshift(task);
    await persistTasks();
    logger.info('task', 'created', { taskId: task.id, mode: task.mode, count: task.count });
    processTask(task.id).catch(error => logger.error('task', 'unhandled processing error', { taskId: task.id, error }));
    res.status(202).json({
      accepted: true,
      created: Math.floor(Date.now() / 1000),
      model: task.model,
      images: [],
      task: publicTask(task)
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
