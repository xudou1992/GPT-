import { readJson, formatApiError, formatTime, formatBytes, copyText, copyToClipboard, clampNumber } from './utils.js';
import { state, STATUS_LABELS, DEFAULT_SIZE } from './state.js';
import {
  loginPanel, appContainer, statusBadge, modelSelect, sizeSelect, sizeHint,
  countInput, concurrencyInput, form, promptInput, promptCount,
  errorMessage, requestState as requestStateEl, resultMeta, taskList, emptyState,
  pagination, prevPage, nextPage, pageInfo, taskTemplate, imageViewer,
  generateButton, referencePanel, referenceImages, referenceState, referenceList,
  referenceFileField, studioSidebar,
  promptAssistant, assistantResult, assistantTitle, assistantPrompt, assistantNotes,
  regCode, currentApiNode, countValue
} from './dom.js';
import { syncAuthState, syncUserUI, handleSessionExpired } from './auth.js';
import { openViewer, closeViewer, stepViewer } from './viewer.js';
import { setMode, addReferenceFiles, renderReferences, flashReferencePanel } from './form.js';

// ── Config ──
export async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    const config = await readJson(response);
    state.authRequired = Boolean(config.authRequired);
    state.currentUser = config.currentUser || null;
    state.isAdminUser = Boolean(config.isAdmin);
    state.apiBaseUrl = config.apiBaseUrl || '';
    if (currentApiNode) currentApiNode.textContent = shortApiNodeLabel(state.apiBaseUrl);
    syncAuthState(config);
    syncUserUI();
    statusBadge.classList.toggle('ready', config.configured);
    statusBadge.classList.toggle('missing', !config.configured);
    statusBadge.querySelector('span:last-child').textContent = config.configured
      ? `${config.model} 已配置` : '未配置 API Key';
    if (Array.isArray(config.configurationHints) && config.configurationHints.length) {
      setError(config.configurationHints.join('；'));
    }
    if (regCode) regCode.hidden = !config.registrationCodeRequired;
    const regTab = document.querySelector('[data-auth-tab="register"]');
    if (regTab) regTab.hidden = !config.allowRegistration;
    fillSelect(modelSelect, config.models || [config.model], config.model);
    fillSizeSelect(config.sizes || []);
    countInput.max = config.maxTaskImages || 50;
    concurrencyInput.max = config.maxTaskConcurrency || 10;
    syncCountValue();
    syncSizeCards();
  } catch (error) {
    appContainer.hidden = false;
    loginPanel.hidden = true;
    statusBadge.classList.add('missing');
    statusBadge.querySelector('span:last-child').textContent = '服务未响应';
    if (currentApiNode) currentApiNode.textContent = '服务未响应';
    setError(error.message);
  }
}

// ── Tasks ──
export async function loadTasks() {
  if (state.authRequired && !loginPanel.hidden) return;
  const isInitialLoad = taskList.children.length <= 1 && !emptyState.hidden;
  if (isInitialLoad) {
    taskList.replaceChildren();
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton skeleton-card';
    taskList.append(skeleton);
  }
  try {
    const params = new URLSearchParams({
      page: String(state.currentPage),
      pageSize: '1',
      status: state.statusFilter
    });
    const response = await fetch(`/api/tasks?${params}`);
    if (response.status === 401) { handleSessionExpired(); return; }
    const payload = await readJson(response);
    if (!response.ok) throw new Error(formatApiError(payload, response.status));
    renderTasks(payload.tasks || [], payload.pagination || {});
    setError('');
  } catch (error) {
    setError(error.message);
    if (taskList.querySelector('.skeleton')) {
      taskList.replaceChildren();
      emptyState.hidden = false;
    }
  }
}

function renderTasks(tasks, paginationMeta) {
  if (imageViewer.hidden) {
    state.currentImages = tasks.flatMap(task => (task.images || []).map(image => ({
      ...image, taskId: task.id, prompt: task.prompt, model: task.model, size: task.size
    })));
  }
  const signature = JSON.stringify({
    tasks: tasks.map(task => ({
      id: task.id, status: task.status, error: task.error, updatedAt: task.updatedAt,
      progress: task.progress, images: (task.images || []).map(img => `${img.filename}:${img.createdAt}`)
    })),
    pagination: paginationMeta
  });
  if (signature === state.lastTaskSignature) return;
  state.lastTaskSignature = signature;
  taskList.replaceChildren();
  emptyState.hidden = tasks.length > 0;
  state.totalPages = paginationMeta.totalPages || 1;
  state.currentPage = paginationMeta.page || state.currentPage;
  resultMeta.textContent = `${paginationMeta.total || 0} 个任务`;
  pagination.hidden = state.totalPages <= 1;
  pageInfo.textContent = `第 ${state.currentPage} / ${state.totalPages} 页`;
  prevPage.disabled = state.currentPage <= 1;
  nextPage.disabled = state.currentPage >= state.totalPages;
  for (const task of tasks) taskList.append(renderTask(task));
  startDurationTimer();
}

const ICON_VIEW = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/></svg>';
const ICON_LINK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/></svg>';
const ICON_DOWNLOAD = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
const ICON_USE_REF = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';

function renderTask(task) {
  const card = taskTemplate.content.firstElementChild.cloneNode(true);
  const status = card.querySelector('.task-status-badge');
  const prompt = card.querySelector('.task-prompt');
  const time = card.querySelector('.task-time');
  const paramsContainer = card.querySelector('.task-params');
  const error = card.querySelector('.task-error');
  const images = card.querySelector('.task-images');
  const cancel = card.querySelector('[data-action="cancel"]');
  const retry = card.querySelector('[data-action="retry"]');

  card.dataset.taskId = task.id;
  card.dataset.status = task.status;
  card.classList.add(`status-${task.status}`);
  status.textContent = STATUS_LABELS[task.status] || task.status;
  status.classList.add(task.status);
  prompt.textContent = task.prompt;
  prompt.title = '点击展开/收起完整提示词';
  prompt.tabIndex = 0;
  prompt.dataset.action = 'toggle-prompt';
  time.textContent = formatTime(task.createdAt);

  const tags = taskMetaTags(task);
  paramsContainer.replaceChildren(...tags.map(t => {
    const div = document.createElement('div');
    div.className = 'param-item';
    div.innerHTML = `<span>${t.label}:</span><b>${t.value}</b>`;
    if (t.durationStarted) div.querySelector('b').dataset.started = t.durationStarted;
    return div;
  }));

  if (task.error) { error.hidden = false; error.textContent = task.error; }
  cancel.hidden = !['pending', 'running'].includes(task.status);
  retry.hidden = ['pending', 'running'].includes(task.status);

  if (['pending', 'running'].includes(task.status) && task.progress) {
    const progressBar = document.createElement('div');
    progressBar.className = 'task-progress';
    const fill = document.createElement('div');
    fill.className = 'task-progress-fill';
    const done = task.progress.done || 0;
    const total = task.count || 1;
    fill.style.width = `${Math.round((done / total) * 100)}%`;
    progressBar.append(fill);
    const progressText = document.createElement('span');
    progressText.className = 'task-progress-text';
    progressText.textContent = `${done} / ${total}`;
    const progressWrapper = document.createElement('div');
    progressWrapper.className = 'task-progress-wrapper';
    progressWrapper.append(progressBar, progressText);
    card.querySelector('.task-content').insertBefore(progressWrapper, images);
  }

  const imageList = task.images || [];
  if (imageList.length === 0) card.classList.add('no-images');
  images.className = `task-images img-count-${Math.min(imageList.length, 3)}`;
  images.replaceChildren(...imageList.map(img => renderImage(img)));
  return card;
}

function renderImage(image) {
  const card = document.createElement('div');
  const link = document.createElement('a');
  const img = document.createElement('img');
  const actions = document.createElement('div');
  const view = document.createElement('button');
  const copy = document.createElement('button');
  const download = document.createElement('a');
  const useRef = document.createElement('button');
  const url = new URL(image.url, window.location.href).href;
  const thumbUrl = image.url.replace('/generated/', '/generated/thumb/');
  card.className = 'task-image-card';
  link.href = 'javascript:void(0)';
  link.dataset.imageUrl = image.url;
  img.alt = image.filename || '生成图片';
  img.draggable = false;
  img.loading = 'lazy';
  img.classList.add('img-loading');
  img.onload = () => img.classList.replace('img-loading', 'img-loaded');
  img.onerror = () => img.classList.replace('img-loading', 'img-error');
  img.src = thumbUrl;
  link.append(img);
  actions.className = 'image-actions';
  view.type = 'button'; view.className = 'image-action-btn'; view.title = '查看原图';
  view.innerHTML = ICON_VIEW + '<span>查看</span>';
  view.dataset.imageUrl = image.url;
  view.onclick = (e) => { e.stopPropagation(); openViewer(image.url); };
  copy.type = 'button'; copy.className = 'image-action-btn'; copy.title = '复制链接';
  copy.innerHTML = ICON_LINK + '<span>链接</span>';
  copy.onclick = (e) => { e.stopPropagation(); copyToClipboard(url, copy); };
  download.className = 'image-action-btn'; download.href = image.url;
  download.download = image.filename || 'image.png'; download.title = '下载原图';
  download.innerHTML = ICON_DOWNLOAD + '<span>下载</span>';
  download.onclick = (e) => e.stopPropagation();
  useRef.type = 'button'; useRef.className = 'image-action-btn'; useRef.title = '以此图为参考继续创作';
  useRef.innerHTML = ICON_USE_REF + '<span>续作</span>';
  useRef.onclick = (e) => { e.stopPropagation(); useImageAsReference(image.url, image.filename); };
  actions.append(view, useRef, copy, download);
  card.append(link, actions);
  card.ondblclick = () => openViewer(image.url);
  return card;
}

function taskMetaTags(task) {
  return [
    { label: '类型', value: task.mode === 'image' ? `图生图 (${task.referenceImageCount}图)` : '文生图' },
    { label: '模型', value: task.model },
    { label: '尺寸', value: task.size },
    { label: '格式', value: (task.outputFormat || 'auto').toUpperCase() },
    { label: '数量', value: `${task.progress?.done || 0}/${task.count}张` },
    task.concurrency > 1 ? { label: '并发', value: task.concurrency } : null,
    durationTag(task)
  ].filter(Boolean);
}

// 将生成的图片作为参考图继续创作
async function useImageAsReference(imageUrl, filename) {
  try {
    setRequestState('正在加载图片...');
    const response = await fetch(imageUrl, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`加载图片失败: ${response.status}`);
    const blob = await response.blob();
    const file = new File([blob], filename || 'reference.png', { type: blob.type || 'image/png' });

    // 切换到图生图模式并添加参考图
    setMode('image');
    addReferenceFiles([file], { replace: true });
    renderReferences();
    flashReferencePanel();

    // 滚动到参考图区域
    referencePanel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setRequestState('已加载为参考图，可继续创作');
    setTimeout(() => setRequestState(''), 2000);
  } catch (error) {
    setError('加载参考图失败: ' + error.message);
    setRequestState('');
  }
}

function durationTag(task) {
  const isActive = ['pending', 'running'].includes(task.status);
  const started = task.startedAt || '';
  return { label: '耗时', value: durationText(task) || '--', durationStarted: isActive ? started : '' };
}

function durationText(task) {
  const started = Date.parse(task.startedAt || '');
  if (!Number.isFinite(started)) return '';
  const ended = ['pending', 'running'].includes(task.status)
    ? Date.now() : Date.parse(task.completedAt || task.updatedAt || '');
  if (!Number.isFinite(ended)) return '';
  const seconds = Math.max(0, Math.round((ended - started) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// ── Task actions ──
export async function handleTaskClick(event) {
  const imageLink = event.target.closest('[data-image-url]');
  if (imageLink) { event.preventDefault(); openViewer(imageLink.dataset.imageUrl); return; }
  const promptToggle = event.target.closest('[data-action="toggle-prompt"]');
  if (promptToggle) {
    promptToggle.classList.toggle('is-expanded');
    return;
  }
  const copyButton = event.target.closest('[data-copy-url]');
  if (copyButton) {
    await copyText(copyButton.dataset.copyUrl);
    copyButton.textContent = '已复制';
    setTimeout(() => { copyButton.textContent = '复制'; }, 1200);
    return;
  }
  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) return;
  const card = actionButton.closest('.task-card');
  const taskId = card?.dataset.taskId;
  if (!taskId) return;
  await runTaskAction(taskId, actionButton.dataset.action);
}

async function runTaskAction(taskId, action) {
  setError('');
  setRequestState(actionLabel(action));
  try {
    const options = action === 'delete' ? { method: 'DELETE' } : { method: 'POST' };
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}${action === 'delete' ? '' : `/${action}`}`, options);
    if (response.status === 401) { handleSessionExpired(); return; }
    if (response.status !== 204) {
      const payload = await readJson(response);
      if (!response.ok) throw new Error(formatApiError(payload, response.status));
    }
    await loadTasks();
    setRequestState('');
  } catch (error) { setError(error.message); setRequestState(''); }
}

function actionLabel(action) {
  if (action === 'cancel') return '正在取消任务...';
  if (action === 'retry') return '正在重试任务...';
  if (action === 'delete') return '正在删除任务...';
  return '正在处理任务...';
}

export async function batchDeleteByStatus(status) {
  setError('');
  setRequestState('正在批量删除...');
  try {
    const response = await fetch(`/api/tasks/batch/${encodeURIComponent(status)}`, { method: 'DELETE' });
    if (response.status === 401) { handleSessionExpired(); return; }
    const payload = await readJson(response);
    if (!response.ok) throw new Error(formatApiError(payload, response.status));
    setRequestState(`已删除 ${payload.deleted} 个任务。`);
    state.currentPage = 1;
    state.lastTaskSignature = '';
    await loadTasks();
  } catch (error) { setError(error.message); setRequestState(''); }
}

// ── Polling ──
let sseRetryDelay = 0;
const SSE_RETRY_BASE = 2000;
const SSE_RETRY_MAX = 30000;

export function startPolling() {
  window.clearInterval(state.refreshTimer);
  if (state.authRequired && !loginPanel.hidden) return;
  if ('EventSource' in window) {
    connectSSE();
    return;
  }
  state.refreshTimer = window.setInterval(loadTasks, 5000);
}

function connectSSE() {
  state.events?.close();
  state.events = new EventSource('/api/events');
  state.events.addEventListener('tasks-updated', () => loadTasks());
  state.events.addEventListener('open', () => { sseRetryDelay = 0; });
  state.events.addEventListener('error', () => {
    state.events?.close();
    state.events = null;
    sseRetryDelay = sseRetryDelay ? Math.min(sseRetryDelay * 2, SSE_RETRY_MAX) : SSE_RETRY_BASE;
    window.clearInterval(state.refreshTimer);
    state.refreshTimer = window.setInterval(loadTasks, 5000);
    setTimeout(() => {
      window.clearInterval(state.refreshTimer);
      if (!state.events) connectSSE();
    }, sseRetryDelay);
  });
}

export function changePage(page) {
  state.currentPage = Math.max(1, Math.min(state.totalPages, page));
  loadTasks();
}

export function syncFilterButtons() {
  document.querySelectorAll('[data-status]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.status === state.statusFilter));
  });
  document.querySelectorAll('[data-mode-filter]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.modeFilter === state.modeFilter));
  });
}

// ── UI helpers ──
export function setError(message) { errorMessage.textContent = message || ''; }
export function setRequestState(message) { requestStateEl.textContent = message || ''; }
export function setSubmitting(isSubmitting) {
  generateButton.disabled = isSubmitting;
  generateButton.querySelector('span:last-child').textContent = isSubmitting ? '生成中...' : '立即生成';
}
export function updatePromptCount() {
  promptCount.textContent = `${promptInput.value.length} / ${promptInput.maxLength}`;
}

export function syncCountValue() {
  if (countValue) countValue.textContent = `${countInput.value || 1} 张`;
}

export function syncSizeCards() {
  document.querySelectorAll('[data-size-card]').forEach(card => {
    const isActive = card.dataset.sizeCard === sizeSelect.value;
    card.classList.toggle('is-active', isActive);
    card.setAttribute('aria-pressed', String(isActive));
  });
}

function shortApiNodeLabel(url) {
  if (!url) return '未配置';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ── Select helpers ──
export function fillSelect(select, values, selected) {
  select.replaceChildren();
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    option.selected = value === selected;
    select.append(option);
  }
}

export function fillSizeSelect(sizes) {
  sizeSelect.replaceChildren();
  const sizeLabels = {
    '3840x2160': '横版 4K 3840 x 2160',
    '2160x3840': '竖版 4K 2160 x 3840',
    '1024x1024': '正方形 1024 x 1024',
    '1536x1024': '横版 1536 x 1024',
    '1024x1536': '竖版 1024 x 1536',
    '1792x1024': '宽幅 1792 x 1024',
    '1024x1792': '长幅 1024 x 1792'
  };
  const values = [...new Set([...(sizes.length ? sizes : [DEFAULT_SIZE]), '1024x1024'])];
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = sizeLabels[value] || value.replace('x', ' × ');
    option.selected = value === DEFAULT_SIZE;
    sizeSelect.append(option);
  }
  syncSizeCards();
}

// ── Live duration timer ──
let durationTimerId = null;

function startDurationTimer() {
  stopDurationTimer();
  tickDurations();
  durationTimerId = window.setInterval(tickDurations, 1000);
}

function stopDurationTimer() {
  if (durationTimerId !== null) { window.clearInterval(durationTimerId); durationTimerId = null; }
}

function tickDurations() {
  const elements = taskList.querySelectorAll('b[data-started]');
  if (!elements.length) { stopDurationTimer(); return; }
  const now = Date.now();
  for (const el of elements) {
    const started = Date.parse(el.dataset.started);
    if (!Number.isFinite(started)) continue;
    const seconds = Math.max(0, Math.round((now - started) / 1000));
    el.textContent = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
}
