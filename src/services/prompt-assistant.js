import {
  getPromptAssistantBaseUrl, promptAssistantApiKey, promptAssistantModel,
  promptAssistantProvider, promptAssistantTimeoutMs, promptAssistantConcurrency,
  maxPromptLength
} from '../config.js';
import { createLimiter, summarizeText, normalizeApiError, describeFetchError } from '../utils.js';
import { logger } from '../logger.js';

const promptAssistantLimiter = createLimiter(promptAssistantConcurrency);

export async function createPromptSuggestion(body) {
  const mode = body.mode === 'image' ? 'image' : 'text';
  const action = ['polish', 'expand', 'ideas'].includes(body.action) ? body.action : 'polish';
  const prompt = String(body.prompt || '').trim();
  const style = String(body.style || '').trim().slice(0, 80);
  const size = String(body.size || '').trim().slice(0, 40);

  if (action !== 'ideas' && prompt.length < 3) throw new Error('请先输入至少 3 个字符的提示词。');
  if (prompt.length > maxPromptLength) throw new Error(`提示词不能超过 ${maxPromptLength} 个字符。`);

  const payload = buildPromptAssistantPayload({ action, mode, prompt, style, size });
  let result;
  let usedModel = promptAssistantModel;

  const fallbackModels = promptAssistantProvider === 'openrouter'
    ? ['google/gemma-3-27b-it:free', 'meta-llama/llama-4-scout:free', 'meta-llama/llama-4-maverick:free', 'qwen/qwen3-30b-a3b:free', 'openrouter/free'].filter(m => m !== promptAssistantModel)
    : [];

  try {
    result = await promptAssistantLimiter(() => callTextApi(payload));
  } catch (primaryError) {
    if (!fallbackModels.length) throw primaryError;
    let fallbackSucceeded = false;
    for (const fallbackModel of fallbackModels) {
      try {
        logger.warn('prompt-assistant', 'fallback', { from: promptAssistantModel, to: fallbackModel, error: primaryError.message });
        result = await promptAssistantLimiter(() => callTextApi({ ...payload, model: fallbackModel }));
        usedModel = fallbackModel;
        fallbackSucceeded = true;
        break;
      } catch (e) { logger.warn('prompt-assistant', 'fallback failed', { model: fallbackModel, error: e.message }); }
    }
    if (!fallbackSucceeded) throw primaryError;
  }

  const content = extractAssistantContent(result);
  const suggestion = parsePromptAssistantContent(content);
  return { action, model: usedModel, prompt: suggestion.prompt, title: suggestion.title, notes: suggestion.notes };
}

function buildPromptAssistantPayload({ action, mode, prompt, style, size }) {
  const templates = {
    polish: {
      temperature: 0.3,
      system: ['你是 AI 图像提示词润色专家。', '规则：', '1. 绝对不能改变用户的主题、主体和核心意图', '2. 只做措辞优化：让描述更精准、更适合 AI 理解', '3. 可以补充 2-3 个细节词（如光线、质感），但不要大幅扩展', '4. 输出的 prompt 长度应接近原始输入，不要写成长文', '5. 只输出 JSON，格式：{"title":"2-4字标题","prompt":"润色后的提示词","notes":["改了什么1","改了什么2"]}'].join('\n'),
      user: (p, ctx) => `润色这段提示词，保持主题不变：\n「${p}」${ctx}`
    },
    expand: {
      temperature: 0.55,
      system: ['你是 AI 图像提示词扩写专家。', '规则：', '1. 保留用户的原始主题和主体', '2. 大幅补充画面细节：场景、构图、光线、材质、色调、氛围、镜头语言', '3. 输出的 prompt 应比原始输入长很多（150-400字），像一段完整的画面描述', '4. 可以加入摄影/设计英文术语（如 cinematic lighting, bokeh）', '5. 只输出 JSON，格式：{"title":"2-4字标题","prompt":"扩写后的提示词","notes":["补充了什么1","补充了什么2"]}'].join('\n'),
      user: (p, ctx) => `扩写这段提示词，大幅丰富画面描述：\n「${p}」${ctx}`
    },
    ideas: {
      temperature: 0.9,
      system: ['你是富有创意的 AI 图像灵感顾问。', '规则：', '1. 如果用户有输入，以它为灵感起点，但给出新颖有趣的创意方向', '2. 如果用户没有输入，自由发挥一个有审美的原创图像创意', '3. prompt 要具体可用，包含主题、场景、风格、氛围（80-250字）', '4. title 要吸引人，像一个作品名', '5. 只输出 JSON，格式：{"title":"创意标题","prompt":"完整的创意提示词","notes":["创意亮点1","创意亮点2"]}'].join('\n'),
      user: (p, ctx) => p ? `以此为灵感起点，给出一个新颖的图像创意：\n「${p}」${ctx}` : `给我一个有审美的原创图像创意。${ctx}`
    }
  };

  const tpl = templates[action];
  const contextParts = [
    mode === 'image' ? '\n模式：图生图（有参考图）' : '',
    style && style !== 'auto' ? `\n风格：${style}` : '',
    size ? `\n尺寸：${size}` : ''
  ].join('');

  const payload = {
    model: promptAssistantModel, temperature: tpl.temperature,
    messages: [{ role: 'system', content: tpl.system }, { role: 'user', content: tpl.user(prompt, contextParts) }]
  };
  if (promptAssistantProvider !== 'openrouter') payload.response_format = { type: 'json_object' };
  return payload;
}

async function callTextApi(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), promptAssistantTimeoutMs);
  try {
    const response = await fetch(`${getPromptAssistantBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${promptAssistantApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: controller.signal
    });
    const contentType = response.headers.get('content-type') || '';
    const result = contentType.includes('application/json') ? await response.json() : { error: summarizeText(await response.text()) };
    if (!response.ok) throw new Error(normalizeApiError(result));
    return result;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('提示词助手响应超时，请稍后重试。');
    if (error instanceof Error && error.message !== 'fetch failed') throw error;
    throw new Error(`调用提示词助手失败：${describeFetchError(error)}`);
  } finally { clearTimeout(timeoutId); }
}

function extractAssistantContent(result) {
  const content = result?.choices?.[0]?.message?.content;
  if (!content) throw new Error('提示词助手没有返回内容。');
  return Array.isArray(content) ? content.map(part => part.text || '').join('\n') : String(content);
}

function parsePromptAssistantContent(content) {
  const fallback = summarizeText(content);
  try {
    const parsed = JSON.parse(content);
    const prompt = String(parsed.prompt || '').trim();
    if (!prompt) throw new Error('empty prompt');
    return {
      title: String(parsed.title || '提示词建议').trim().slice(0, 80),
      prompt: prompt.slice(0, maxPromptLength),
      notes: Array.isArray(parsed.notes) ? parsed.notes.map(n => String(n).trim()).filter(Boolean).slice(0, 4) : []
    };
  } catch {
    return { title: '提示词建议', prompt: fallback, notes: ['上游返回了非标准 JSON，已自动提取主要内容。'] };
  }
}
