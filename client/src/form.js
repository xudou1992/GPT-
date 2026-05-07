import { readJson, formatApiError, formatBytes, clampNumber } from './utils.js';
import { state, DEFAULT_SIZE, MAX_REFERENCE_IMAGES } from './state.js';
import {
  form, promptInput, sizeSelect, sizeHint,
  countInput, concurrencyInput,
  referencePanel, referenceImages, referenceState, referenceList, referenceFileField,
  promptAssistant, assistantResult, assistantTitle, assistantPrompt, assistantNotes,
  studioSidebar, mobileOverlay
} from './dom.js';
import { handleSessionExpired } from './auth.js';
import { loadTasks, setError, setRequestState, setSubmitting, updatePromptCount } from './tasks.js';

export function setMode(nextMode) {
  state.mode = nextMode === 'image' ? 'image' : 'text';
  document.querySelectorAll('[data-mode]').forEach(button => {
    button.setAttribute('aria-selected', String(button.dataset.mode === state.mode));
  });
  referencePanel.hidden = state.mode !== 'image';
}

export async function handleSubmit(event) {
  if (event) event.preventDefault();
  setError(''); setRequestState(''); clampCountAndConcurrency();
  const formData = new FormData(form);
  const size = formData.get('size') || DEFAULT_SIZE;
  const sizeError = validateSize(size);
  if (sizeError) { setError(sizeError); return; }
  if (state.mode === 'image' && state.selectedReferences.length === 0) { setError('图生图请先选择参考图。'); return; }
  formData.set('mode', state.mode); formData.set('size', size);
  formData.delete('referenceImages');
  for (const file of state.selectedReferences) formData.append('referenceImages', file, file.name);
  setSubmitting(true);
  const sizePixels = parseSizePixels(size);
  const hint = (state.mode === 'image' && sizePixels > 2000 * 2000)
    ? '正在添加任务…大尺寸图生图可能需要 2-5 分钟，请耐心等待'
    : '正在添加任务...';
  setRequestState(hint);
  try {
    const response = await fetch('/api/tasks', { method: 'POST', body: formData });
    const payload = await readJson(response);
    if (!response.ok) throw new Error(formatApiError(payload, response.status));
    state.currentPage = 1; state.lastTaskSignature = '';
    setRequestState(`任务 ${payload.task.id.slice(0, 8)} 已添加。`);
    await loadTasks();
    if (window.innerWidth <= 768 && studioSidebar?.classList.contains('is-open')) closeMobileSidebar();
  } catch (error) { setError(error.message); setRequestState(''); }
  finally { setSubmitting(false); }
}

export function closeMobileSidebar() {
  document.body.classList.remove('sidebar-open');
  studioSidebar.classList.remove('is-open');
  mobileOverlay.classList.remove('is-open');
}

export function validateSize(size) {
  const match = String(size).match(/^(\d{2,4})x(\d{2,4})$/);
  if (!match) return '尺寸格式不正确。';
  const w = Number(match[1]), h = Number(match[2]);
  if (w % 16 !== 0 || h % 16 !== 0) return '尺寸宽高都必须是 16 的倍数。';
  if (Math.min(w, h) < 16) return '尺寸宽高不能小于 16。';
  if (Math.max(w, h) > 4096) return '最长边不能超过 4096。';
  if (w * h > 4096 * 4096) return '总像素不能超过 16777216。';
  return '';
}

function parseSizePixels(size) {
  const m = String(size).match(/^(\d+)x(\d+)$/);
  return m ? Number(m[1]) * Number(m[2]) : 0;
}

export function clampCountAndConcurrency() {
  const count = clampNumber(countInput.value, 1, Number(countInput.max || 50), 1);
  const concurrency = clampNumber(concurrencyInput.value, 1, Math.min(Number(concurrencyInput.max || 10), count), 1);
  countInput.value = count; concurrencyInput.value = concurrency;
  document.querySelector('#countValue')?.replaceChildren(`${count} 张`);
}

export function updateCustomSizeVisibility() { if (sizeHint) sizeHint.hidden = false; }

export function addReferenceFiles(files, { replace = false } = {}) {
  state.selectedReferences = validateReferenceFiles(replace ? files : [...state.selectedReferences, ...files]);
  referenceImages.value = '';
}

export function validateReferenceFiles(files) {
  if (files.length > MAX_REFERENCE_IMAGES) throw new Error(`参考图最多 ${MAX_REFERENCE_IMAGES} 张。`);
  if (files.some(f => !f.type.startsWith('image/'))) throw new Error('参考图必须是图片文件。');
  return files;
}

export function renderReferences() {
  referenceList.replaceChildren();
  const totalBytes = state.selectedReferences.reduce((s, f) => s + f.size, 0);
  referenceState.textContent = state.selectedReferences.length
    ? `${state.selectedReferences.length} 张 · ${formatBytes(totalBytes)}`
    : '可拖拽或粘贴图片，最多 10 张，不限制单张或总大小';
  for (const [index, file] of state.selectedReferences.entries()) {
    const item = document.createElement('div'); item.className = 'reference-item';
    const preview = document.createElement('img');
    preview.src = URL.createObjectURL(file); preview.alt = '';
    preview.onload = () => URL.revokeObjectURL(preview.src);
    const info = document.createElement('div'); info.className = 'file-info';
    const name = document.createElement('span'); name.className = 'file-name'; name.textContent = file.name;
    const size = document.createElement('span'); size.className = 'file-size'; size.textContent = formatBytes(file.size);
    info.append(name, size);
    const actions = document.createElement('div'); actions.className = 'item-actions';
    const viewBtn = document.createElement('button'); viewBtn.type = 'button'; viewBtn.title = '预览'; viewBtn.innerHTML = '🔍';
    viewBtn.onclick = () => window.open(URL.createObjectURL(file), '_blank');
    const downloadBtn = document.createElement('button'); downloadBtn.type = 'button'; downloadBtn.title = '下载'; downloadBtn.innerHTML = '⤓';
    downloadBtn.onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); };
    const removeBtn = document.createElement('button'); removeBtn.className = 'btn-remove'; removeBtn.type = 'button';
    removeBtn.title = '移除'; removeBtn.innerHTML = '✕'; removeBtn.dataset.referenceIndex = String(index);
    actions.append(viewBtn, downloadBtn, removeBtn);
    item.append(preview, info, actions);
    referenceList.append(item);
  }
}

export function handleReferenceDragOver(event) {
  if (state.mode !== 'image' || !event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault(); referenceFileField.classList.add('is-dragging');
}

export function handleReferenceDragLeave(event) {
  if (!referenceFileField.contains(event.relatedTarget)) referenceFileField.classList.remove('is-dragging');
}

export function handleReferenceDrop(event) {
  if (state.mode !== 'image') return;
  event.preventDefault(); referenceFileField.classList.remove('is-dragging'); setError('');
  try { addReferenceFiles(Array.from(event.dataTransfer?.files || [])); renderReferences(); }
  catch (error) { setError(error.message); }
}

export function handlePaste(event) {
  const items = event.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (const item of items) { if (item.type.startsWith('image/')) { const f = item.getAsFile(); if (f) files.push(f); } }
  if (!files.length) return;
  event.preventDefault(); event.stopPropagation(); setError('');
  if (state.mode !== 'image') setMode('image');
  try { addReferenceFiles(files); renderReferences(); flashReferencePanel(); }
  catch (error) { setError(error.message); }
}

export function flashReferencePanel() {
  if (!referencePanel) return;
  referencePanel.classList.remove('paste-flash');
  void referencePanel.offsetWidth;
  referencePanel.classList.add('paste-flash');
  setTimeout(() => referencePanel.classList.remove('paste-flash'), 800);
}

export function handleReferenceListClick(event) {
  const button = event.target.closest('[data-reference-index]');
  if (!button) return;
  state.selectedReferences.splice(Number(button.dataset.referenceIndex), 1);
  renderReferences();
}

export async function handleAssistantClick(event) {
  const button = event.target.closest('[data-assistant-action]');
  if (!button) return;
  const action = button.dataset.assistantAction;
  const currentPrompt = promptInput.value.trim();
  if (action !== 'ideas' && currentPrompt.length < 3) {
    setError('请先输入至少 3 个字符的提示词再使用润色/扩写。'); promptInput.focus(); return;
  }
  setError(''); setAssistantLoading(button, true);
  try {
    const response = await fetch('/api/prompt-assistant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, mode: state.mode, prompt: promptInput.value, size: sizeSelect.value, style: document.querySelector('#quality')?.value || '' })
    });
    if (response.status === 401) { handleSessionExpired(); return; }
    const payload = await readJson(response);
    if (!response.ok) throw new Error(formatApiError(payload, response.status));
    renderAssistantSuggestion(payload);
  } catch (error) { setError(error.message); }
  finally { setAssistantLoading(button, false); }
}

function renderAssistantSuggestion(payload) {
  state.assistantSuggestion = payload.prompt || '';
  assistantTitle.textContent = payload.title || '提示词建议';
  assistantPrompt.textContent = state.assistantSuggestion;
  assistantNotes.replaceChildren(...(payload.notes || []).map(note => { const li = document.createElement('li'); li.textContent = note; return li; }));
  assistantNotes.hidden = !(payload.notes || []).length;
  assistantResult.hidden = !state.assistantSuggestion;
}

export function applyAssistantSuggestion() {
  if (!state.assistantSuggestion) return;
  promptInput.value = state.assistantSuggestion;
  assistantResult.hidden = true;
  updatePromptCount(); promptInput.focus();
}

function setAssistantLoading(activeButton, isLoading) {
  promptAssistant.querySelectorAll('[data-assistant-action]').forEach(button => {
    button.disabled = isLoading;
    if (button === activeButton) {
      const label = button.querySelector('.action-label');
      if (label) { label.dataset.originalText ||= label.textContent; label.textContent = isLoading ? '处理中…' : label.dataset.originalText; }
    }
  });
}

export function initCustomSelects() {
  document.querySelectorAll('select:not(.is-hidden)').forEach(select => {
    if (select.id === 'referenceImages') return;
    if (select.matches('[data-native-hidden], .native-select-hidden')) return;
    const container = document.createElement('div'); container.className = 'custom-select-container';
    const trigger = document.createElement('div'); trigger.className = 'custom-select-trigger';
    const optionsWrapper = document.createElement('div'); optionsWrapper.className = 'custom-select-options';
    select.classList.add('is-hidden');
    select.parentNode.insertBefore(container, select);
    container.append(select, trigger, optionsWrapper);
    const updateTrigger = () => {
      const selectedOption = select.options[select.selectedIndex];
      trigger.textContent = selectedOption ? selectedOption.textContent : '请选择...';
    };
    const updateOptions = () => {
      optionsWrapper.replaceChildren();
      Array.from(select.options).forEach((opt, idx) => {
        const customOpt = document.createElement('div'); customOpt.className = 'custom-option';
        if (opt.selected) customOpt.classList.add('is-selected');
        customOpt.textContent = opt.textContent;
        customOpt.onclick = (e) => { e.stopPropagation(); select.selectedIndex = idx; select.dispatchEvent(new Event('change', { bubbles: true })); container.classList.remove('is-open'); updateTrigger(); };
        optionsWrapper.append(customOpt);
      });
    };
    trigger.onclick = (e) => {
      e.stopPropagation();
      const wasOpen = container.classList.contains('is-open');
      document.querySelectorAll('.custom-select-container').forEach(c => c.classList.remove('is-open'));
      if (!wasOpen) { updateOptions(); container.classList.add('is-open'); }
    };
    const observer = new MutationObserver(() => updateTrigger());
    observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['selected'] });
    updateTrigger();
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.custom-select-container').forEach(c => c.classList.remove('is-open'));
  });
}
