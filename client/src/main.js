import './styles/index.css';
import { state } from './state.js';
import { initTheme, toggleTheme } from './theme.js';
import { handleLogin, handleRegister, handleLogout, switchAuthTab, openInvitesModal, closeInvitesModal, generateInvites } from './auth.js';
import {
  loadConfig, loadTasks, startPolling, handleTaskClick, changePage, syncFilterButtons,
  updatePromptCount, setError, batchDeleteByStatus, syncSizeCards
} from './tasks.js';
import { openViewer, closeViewer, stepViewer } from './viewer.js';
import { copyText } from './utils.js';
import { openApiSettingsModal, closeApiSettingsModal, syncApiSettingsButton, testApiBase, saveApiBase } from './api-settings.js';
import {
  setMode, handleSubmit, closeMobileSidebar, clampCountAndConcurrency, updateCustomSizeVisibility,
  addReferenceFiles, renderReferences, handleReferenceDragOver, handleReferenceDragLeave,
  handleReferenceDrop, handlePaste, handleReferenceListClick, handleAssistantClick,
  applyAssistantSuggestion, initCustomSelects
} from './form.js';
import {
  loginForm, registerForm, logoutButton, themeToggle,
  adminInvitesButton, apiSettingsButton, apiSettingsModal, invitesModal, generateInvitesBtn,
  quickApiSettingsButton, sidebarApiSettingsButton,
  form, promptInput, promptCount, clearPrompt, promptAssistant, dismissAssistant,
  assistantResult, applyAssistantPrompt as applyAssistantPromptBtn,
  sizeSelect, countInput, concurrencyInput, refreshButton,
  prevPage, nextPage, taskList, referenceImages, clearReferences, referenceList,
  referenceFileField, imageViewer, viewerClose, viewerPrev, viewerNext, viewerCopy,
  mobileFab, mobileOverlay, studioSidebar, loginPanel, generateButton,
  userMenuTrigger, userMenuDropdown, batchTrigger, batchDropdown
} from './dom.js';

setupErrorReporting();
boot();

function setupErrorReporting() {
  const report = (payload) => {
    try { navigator.sendBeacon('/api/admin/client-errors', new Blob([JSON.stringify(payload)], { type: 'application/json' })); } catch {}
  };
  window.onerror = (message, source, lineno, colno) => {
    report({ type: 'error', message, source, lineno, colno, ua: navigator.userAgent });
  };
  window.onunhandledrejection = (event) => {
    const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
    report({ type: 'unhandledrejection', message, ua: navigator.userAgent });
  };
}

async function boot() {
  try {
    initTheme();
    setMode(state.mode);
    bindEvents();
    initCustomSelects();
    updatePromptCount();
    await loadConfig();
    if (!state.authRequired || loginPanel.hidden) {
      await loadTasks();
      startPolling();
    }
  } catch (e) {
    console.error('[boot]', e);
  }
}

function bindEvents() {
  loginForm.addEventListener('submit', handleLogin);
  registerForm.addEventListener('submit', handleRegister);
  logoutButton.addEventListener('click', handleLogout);
  themeToggle.addEventListener('click', toggleTheme);
  if (userMenuTrigger) userMenuTrigger.addEventListener('click', () => {
    userMenuDropdown.classList.toggle('is-open');
  });
  document.addEventListener('click', (e) => {
    if (userMenuDropdown && !e.target.closest('.user-menu')) userMenuDropdown.classList.remove('is-open');
  });
  if (adminInvitesButton) adminInvitesButton.addEventListener('click', () => { userMenuDropdown.classList.remove('is-open'); openInvitesModal(); });
  if (apiSettingsButton) apiSettingsButton.addEventListener('click', () => { userMenuDropdown.classList.remove('is-open'); openApiSettingsModal(); });
  if (quickApiSettingsButton) quickApiSettingsButton.addEventListener('click', () => {
    userMenuDropdown.classList.remove('is-open');
    openApiSettingsModal();
  });
  if (sidebarApiSettingsButton) sidebarApiSettingsButton.addEventListener('click', openApiSettingsModal);
  if (apiSettingsModal) apiSettingsModal.addEventListener('click', (e) => {
    if (e.target.closest('[data-modal-close]')) closeApiSettingsModal();
  });
  const apiBaseSelect = document.querySelector('#apiBaseSelect');
  const customApiBase = document.querySelector('#customApiBase');
  if (apiBaseSelect && customApiBase) apiBaseSelect.addEventListener('change', () => {
    customApiBase.hidden = apiBaseSelect.value !== '__custom__';
  });
  if (invitesModal) invitesModal.addEventListener('click', (e) => { if (e.target.closest('[data-modal-close]')) closeInvitesModal(); });
  if (generateInvitesBtn) generateInvitesBtn.addEventListener('click', generateInvites);
  if (document.querySelector('#testApiBaseBtn')) document.querySelector('#testApiBaseBtn').addEventListener('click', testApiBase);
  if (document.querySelector('#saveApiBaseBtn')) document.querySelector('#saveApiBaseBtn').addEventListener('click', saveApiBase);
  if (imageViewer) imageViewer.addEventListener('click', (e) => {
    if (e.target.closest('[data-viewer-close]') || e.target.classList.contains('viewer-backdrop')) closeViewer();
  });
  if (viewerClose) viewerClose.addEventListener('click', closeViewer);
  document.querySelectorAll('[data-auth-tab]').forEach(btn => { btn.addEventListener('click', () => switchAuthTab(btn.dataset.authTab)); });
  form.addEventListener('submit', handleSubmit);
  promptInput.addEventListener('input', updatePromptCount);
  clearPrompt.addEventListener('click', () => {
    promptInput.value = ''; state.assistantSuggestion = ''; assistantResult.hidden = true; updatePromptCount(); promptInput.focus();
  });
  if (promptAssistant) promptAssistant.addEventListener('click', handleAssistantClick);
  applyAssistantPromptBtn.addEventListener('click', applyAssistantSuggestion);
  if (dismissAssistant) dismissAssistant.addEventListener('click', () => { assistantResult.hidden = true; });
  sizeSelect.addEventListener('change', () => { updateCustomSizeVisibility(); syncSizeCards(); });
  countInput.addEventListener('change', clampCountAndConcurrency);
  countInput.addEventListener('input', clampCountAndConcurrency);
  concurrencyInput.addEventListener('change', clampCountAndConcurrency);
  concurrencyInput.addEventListener('input', clampCountAndConcurrency);
  refreshButton.addEventListener('click', loadTasks);
  prevPage.addEventListener('click', () => changePage(state.currentPage - 1));
  nextPage.addEventListener('click', () => changePage(state.currentPage + 1));
  document.querySelectorAll('[data-mode]').forEach(button => { button.addEventListener('click', () => setMode(button.dataset.mode)); });
  document.querySelectorAll('[data-size-card]').forEach(button => {
    button.addEventListener('click', () => {
      sizeSelect.value = button.dataset.sizeCard;
      sizeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
  document.querySelectorAll('[data-prompt]').forEach(button => {
    button.addEventListener('click', () => { promptInput.value = button.dataset.prompt; updatePromptCount(); promptInput.focus(); });
  });
  document.querySelectorAll('[data-status]').forEach(button => {
    button.addEventListener('click', () => { state.statusFilter = button.dataset.status; state.currentPage = 1; syncFilterButtons(); loadTasks(); });
  });
  document.querySelectorAll('[data-mode-filter]').forEach(button => {
    button.addEventListener('click', () => { state.modeFilter = button.dataset.modeFilter; state.currentPage = 1; syncFilterButtons(); loadTasks(); });
  });
  referenceImages.addEventListener('change', () => {
    try { addReferenceFiles(Array.from(referenceImages.files || []), { replace: true }); renderReferences(); }
    catch (error) { referenceImages.value = ''; state.selectedReferences = []; renderReferences(); setError(error.message); }
  });
  clearReferences.addEventListener('click', () => { state.selectedReferences = []; referenceImages.value = ''; renderReferences(); });
  taskList.addEventListener('click', handleTaskClick);
  referenceFileField.addEventListener('dragover', handleReferenceDragOver);
  referenceFileField.addEventListener('dragleave', handleReferenceDragLeave);
  referenceFileField.addEventListener('drop', handleReferenceDrop);
  referenceList.addEventListener('click', handleReferenceListClick);
  document.addEventListener('paste', handlePaste);
  promptInput.addEventListener('paste', handlePaste);
  referenceFileField.addEventListener('paste', handlePaste);
  referenceFileField.setAttribute('tabindex', '0');
  document.addEventListener('keydown', handleKeydown);
  imageViewer.addEventListener('click', (event) => { if (event.target.closest('[data-viewer-close]')) closeViewer(); });
  viewerPrev.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); stepViewer(-1); });
  viewerNext.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); stepViewer(1); });
  viewerCopy.addEventListener('click', async () => {
    await copyText(viewerCopy.dataset.copyUrl || '');
    viewerCopy.textContent = '已复制';
    setTimeout(() => { viewerCopy.textContent = '复制链接'; }, 1200);
  });
  if (batchTrigger) batchTrigger.addEventListener('click', () => {
    batchDropdown?.classList.toggle('is-open');
  });
  document.addEventListener('click', (e) => {
    if (batchDropdown && !e.target.closest('.batch-menu')) batchDropdown.classList.remove('is-open');
  });
  if (batchDropdown) batchDropdown.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-batch-delete]');
    if (!btn) return;
    const status = btn.dataset.batchDelete;
    const labels = { succeeded: '已完成', failed: '失败', canceled: '已取消' };
    if (!confirm(`确定删除全部${labels[status] || ''}的任务吗？此操作不可撤销。`)) return;
    batchDropdown.classList.remove('is-open');
    await batchDeleteByStatus(status);
  });
  if (mobileFab) mobileFab.addEventListener('click', () => {
    document.body.classList.add('sidebar-open'); studioSidebar.classList.add('is-open'); mobileOverlay.classList.add('is-open');
  });
  if (mobileOverlay) mobileOverlay.addEventListener('click', closeMobileSidebar);
  syncApiSettingsButton();
}

function handleKeydown(event) {
  if ((event.key === 'Enter' || event.key === ' ') && document.activeElement?.dataset?.action === 'toggle-prompt') {
    event.preventDefault();
    document.activeElement.classList.toggle('is-expanded');
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    if (document.activeElement === promptInput && !generateButton.disabled) { event.preventDefault(); form.requestSubmit(); return; }
  }
  if (imageViewer.hidden) return;
  if (event.key === 'Escape') closeViewer();
  else if (event.key === 'ArrowLeft') stepViewer(-1);
  else if (event.key === 'ArrowRight') stepViewer(1);
}
