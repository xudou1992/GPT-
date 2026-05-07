export function formatBytes(bytes) {
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

export function formatTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

export function summarizeText(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

export function formatApiError(result, status) {
  const message = result?.error || `请求失败，HTTP ${status}`;
  const details = typeof result?.details === 'string'
    ? result.details
    : result?.details?.error?.message;
  return details && details !== message ? `${message}（${details}）` : message;
}

export async function readJson(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return { error: summarizeText(await response.text()) || `HTTP ${response.status}` };
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export async function copyToClipboard(text, button) {
  await copyText(text);
  if (!button) return;
  const original = button.textContent;
  button.textContent = '✓';
  setTimeout(() => { button.textContent = original; }, 1200);
}
