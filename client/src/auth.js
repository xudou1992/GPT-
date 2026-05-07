import { readJson, formatApiError, copyText } from './utils.js';
import { formatTime } from './utils.js';
import { state } from './state.js';
import {
  loginPanel, appContainer, loginForm, registerForm,
  loginError, registerError, loginUsername, loginPassword,
  regUsername, regPassword, regConfirm, regCode,
  navUser, logoutButton, userAvatar, userMenu, adminInvitesButton, adminDashboardLink, apiSettingsButton,
  adminQuickActions, quickApiSettingsButton, quickAdminDashboardLink,
  invitesModal, invitesList, invitesError, inviteCount, generateInvitesBtn,
  taskList, emptyState, resultMeta, pagination
} from './dom.js';
import { loadConfig, loadTasks, startPolling } from './tasks.js';

export function syncAuthState(config) {
  const shouldShowLogin = Boolean(config.authRequired && !config.authenticated);
  loginPanel.hidden = !shouldShowLogin;
  appContainer.hidden = shouldShowLogin;
  document.body.classList.toggle('login-open', shouldShowLogin);
  if (shouldShowLogin) loginUsername.focus();
}

export function syncUserUI() {
  if (state.currentUser) {
    if (navUser) navUser.textContent = state.currentUser;
    if (userAvatar) userAvatar.textContent = state.currentUser.charAt(0).toUpperCase();
    if (userMenu) userMenu.hidden = false;
  } else {
    if (userMenu) userMenu.hidden = true;
  }
  if (adminInvitesButton) adminInvitesButton.hidden = !state.isAdminUser;
  if (apiSettingsButton) apiSettingsButton.hidden = !state.isAdminUser;
  if (adminDashboardLink) adminDashboardLink.hidden = !state.isAdminUser;
  if (adminQuickActions) adminQuickActions.hidden = !state.isAdminUser;
  if (quickApiSettingsButton) quickApiSettingsButton.hidden = !state.isAdminUser;
  if (quickAdminDashboardLink) quickAdminDashboardLink.hidden = !state.isAdminUser;
}

export async function handleLogin(event) {
  event.preventDefault();
  loginError.textContent = '';
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: loginUsername.value.trim(),
        password: loginPassword.value
      })
    });
    const payload = await readJson(response);
    if (!response.ok) throw new Error(formatApiError(payload, response.status));
    state.currentUser = payload.user || null;
    localStorage.setItem('ias_logged_in', '1');
    loginUsername.value = '';
    loginPassword.value = '';
    loginPanel.hidden = true;
    appContainer.hidden = false;
    document.body.classList.remove('login-open');
    document.body.classList.add('auth-cached');
    await loadConfig();
    await loadTasks();
    startPolling();
  } catch (error) {
    loginError.textContent = error.message;
  }
}

export async function handleRegister(event) {
  event.preventDefault();
  registerError.textContent = '';
  if (regPassword.value !== regConfirm.value) {
    registerError.textContent = '两次输入的密码不一致。';
    return;
  }
  try {
    const response = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: regUsername.value.trim(),
        password: regPassword.value,
        code: regCode.value.trim()
      })
    });
    const payload = await readJson(response);
    if (!response.ok) throw new Error(formatApiError(payload, response.status));
    state.currentUser = payload.user || null;
    localStorage.setItem('ias_logged_in', '1');
    regUsername.value = '';
    regPassword.value = '';
    regConfirm.value = '';
    regCode.value = '';
    loginPanel.hidden = true;
    appContainer.hidden = false;
    document.body.classList.remove('login-open');
    document.body.classList.add('auth-cached');
    await loadConfig();
    await loadTasks();
    startPolling();
  } catch (error) {
    registerError.textContent = error.message;
  }
}

export async function handleLogout() {
  localStorage.removeItem('ias_logged_in');
  document.body.classList.remove('auth-cached');
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  state.currentUser = null;
  syncUserUI();
  state.events?.close();
  state.events = null;
  window.clearInterval(state.refreshTimer);
  taskList.replaceChildren(emptyState);
  emptyState.hidden = false;
  state.lastTaskSignature = '';
  resultMeta.textContent = '等待任务';
  pagination.hidden = true;
  await loadConfig();
}

export function handleSessionExpired() {
  localStorage.removeItem('ias_logged_in');
  document.body.classList.remove('auth-cached');
  state.authRequired = true;
  state.currentUser = null;
  loginPanel.hidden = false;
  appContainer.hidden = true;
  document.body.classList.add('login-open');
  state.events?.close();
  state.events = null;
  window.clearInterval(state.refreshTimer);
  syncUserUI();
  loginError.textContent = '登录已过期，请重新登录。';
  setTimeout(() => loginUsername?.focus(), 100);
}

export function switchAuthTab(tab) {
  document.querySelectorAll('[data-auth-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.authTab === tab);
  });
  loginForm.hidden = tab !== 'login';
  registerForm.hidden = tab !== 'register';
  loginError.textContent = '';
  registerError.textContent = '';
}

// ── Invites ──
export async function openInvitesModal() {
  invitesModal.hidden = false;
  invitesError.textContent = '';
  await loadInvites();
}

export function closeInvitesModal() {
  invitesModal.hidden = true;
}

async function loadInvites() {
  invitesList.replaceChildren();
  try {
    const response = await fetch('/api/admin/invites');
    if (response.status === 401 || response.status === 403) {
      invitesError.textContent = '需要管理员权限。';
      return;
    }
    const payload = await readJson(response);
    if (!response.ok) throw new Error(formatApiError(payload, response.status));
    renderInvites(payload.invites || []);
  } catch (error) {
    invitesError.textContent = error.message;
  }
}

function renderInvites(list) {
  invitesList.replaceChildren();
  if (list.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'invites-empty';
    empty.textContent = '还没有邀请码，点击上方按钮生成。';
    invitesList.append(empty);
    return;
  }
  for (const invite of list) {
    const row = document.createElement('div');
    row.className = 'invite-row' + (invite.usedAt ? ' is-used' : '');
    const codeBox = document.createElement('div');
    codeBox.className = 'invite-code';
    codeBox.textContent = invite.code;
    const meta = document.createElement('div');
    meta.className = 'invite-meta';
    meta.textContent = invite.usedAt
      ? `已被 ${invite.usedBy} 使用于 ${formatTime(invite.usedAt)}`
      : `未使用 · 创建于 ${formatTime(invite.createdAt)}`;
    const actions = document.createElement('div');
    actions.className = 'invite-actions';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'ghost-button';
    copyBtn.textContent = '复制';
    copyBtn.onclick = async () => {
      await copyText(invite.code);
      copyBtn.textContent = '已复制';
      setTimeout(() => copyBtn.textContent = '复制', 1200);
    };
    actions.append(copyBtn);
    if (!invite.usedAt) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'ghost-button';
      delBtn.style.color = 'var(--danger)';
      delBtn.textContent = '删除';
      delBtn.onclick = () => deleteInvite(invite.code);
      actions.append(delBtn);
    }
    row.append(codeBox, meta, actions);
    invitesList.append(row);
  }
}

export async function generateInvites() {
  invitesError.textContent = '';
  generateInvitesBtn.disabled = true;
  try {
    const response = await fetch('/api/admin/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: Number(inviteCount.value) || 1 })
    });
    const payload = await readJson(response);
    if (!response.ok) throw new Error(formatApiError(payload, response.status));
    await loadInvites();
  } catch (error) {
    invitesError.textContent = error.message;
  } finally {
    generateInvitesBtn.disabled = false;
  }
}

async function deleteInvite(code) {
  if (!confirm(`确定删除邀请码 ${code} 吗？`)) return;
  invitesError.textContent = '';
  try {
    const response = await fetch(`/api/admin/invites/${encodeURIComponent(code)}`, { method: 'DELETE' });
    if (response.status !== 204) {
      const payload = await readJson(response);
      if (!response.ok) throw new Error(formatApiError(payload, response.status));
    }
    await loadInvites();
  } catch (error) {
    invitesError.textContent = error.message;
  }
}
