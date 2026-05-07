import { readJson, formatApiError } from './utils.js';
import { state } from './state.js';
import {
  apiSettingsButton, quickApiSettingsButton, adminQuickActions, apiSettingsModal,
  apiBaseSelect, customApiBase, customApiKey, customImageModel,
  apiBaseCurrent, apiSettingsError, apiSettingsResult, currentApiNode,
  saveApiBaseBtn, testApiBaseBtn
} from './dom.js';
import { loadConfig } from './tasks.js';

let presets = [];

export async function openApiSettingsModal() {
  if (!apiSettingsModal) return;
  apiSettingsModal.hidden = false;
  apiSettingsError.textContent = '';
  apiSettingsResult.textContent = '';
  await loadApiSettings();
}

export function closeApiSettingsModal() {
  if (apiSettingsModal) apiSettingsModal.hidden = true;
}

export async function loadApiSettings() {
  const [baseRes, keyRes, modelRes] = await Promise.all([
    fetch('/api/admin/settings/api-base'),
    fetch('/api/admin/settings/api-key'),
    fetch('/api/admin/settings/models')
  ]);

  const [basePayload, keyPayload, modelPayload] = await Promise.all([
    readJson(baseRes),
    readJson(keyRes),
    readJson(modelRes)
  ]);

  if (!baseRes.ok) throw new Error(formatApiError(basePayload, baseRes.status));
  if (!keyRes.ok) throw new Error(formatApiError(keyPayload, keyRes.status));
  if (!modelRes.ok) throw new Error(formatApiError(modelPayload, modelRes.status));

  presets = basePayload.presets || [];
  renderApiSettings(basePayload.current || state.apiBaseUrl || '');
  if (customApiKey) customApiKey.value = keyPayload.current || '';
  if (customImageModel) customImageModel.value = 'gpt-image-2';
}

export function renderApiSettings(current) {
  if (!apiBaseSelect || !customApiBase) return;
  apiBaseSelect.replaceChildren();
  for (const preset of presets) {
    const option = document.createElement('option');
    option.value = preset.value;
    option.textContent = `${preset.label} - ${preset.value}`;
    option.selected = preset.value === current;
    apiBaseSelect.append(option);
  }
  const customOption = document.createElement('option');
  customOption.value = '__custom__';
  customOption.textContent = '自定义地址';
  customOption.selected = !presets.some(preset => preset.value === current);
  apiBaseSelect.append(customOption);
  customApiBase.value = current;
  customApiBase.hidden = apiBaseSelect.value !== '__custom__';
  if (apiBaseCurrent) apiBaseCurrent.textContent = current || '--';
  if (currentApiNode) currentApiNode.textContent = shortApiNodeLabel(current);
}

export function selectedApiBaseUrl() {
  return apiBaseSelect?.value === '__custom__' ? customApiBase.value.trim() : apiBaseSelect.value;
}

export async function testApiBase() {
  apiSettingsError.textContent = '';
  apiSettingsResult.textContent = '正在测试...';
  testApiBaseBtn.disabled = true;
  try {
    const response = await fetch('/api/admin/settings/api-base/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: selectedApiBaseUrl(),
        key: customApiKey?.value.trim() || '',
        model: 'gpt-image-2'
      })
    });
    const payload = await readJson(response);
    if (!response.ok) throw new Error(formatApiError(payload, response.status));
    apiSettingsResult.textContent = payload.ok && payload.modelSupported
      ? `节点可用：HTTP ${payload.status}，${payload.elapsedMs}ms，支持 ${payload.model || 'gpt-image-2'}`
      : `节点不可用：HTTP ${payload.status || '--'}，${payload.elapsedMs || 0}ms${payload.message ? `，${payload.message}` : ''}`;
  } catch (error) {
    apiSettingsResult.textContent = '';
    apiSettingsError.textContent = error.message;
  } finally {
    testApiBaseBtn.disabled = false;
  }
}

export async function saveApiBase() {
  apiSettingsError.textContent = '';
  apiSettingsResult.textContent = '正在保存...';
  saveApiBaseBtn.disabled = true;
  try {
    const baseResponse = await fetch('/api/admin/settings/api-base', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: selectedApiBaseUrl() })
    });
    const basePayload = await readJson(baseResponse);
    if (!baseResponse.ok) throw new Error(formatApiError(basePayload, baseResponse.status));

    const key = customApiKey?.value.trim() || '';
    const keyResponse = await fetch('/api/admin/settings/api-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const keyPayload = await readJson(keyResponse);
    if (!keyResponse.ok) throw new Error(formatApiError(keyPayload, keyResponse.status));

    const modelResponse = await fetch('/api/admin/settings/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultModel: 'gpt-image-2' })
    });
    const modelPayload = await readJson(modelResponse);
    if (!modelResponse.ok) throw new Error(formatApiError(modelPayload, modelResponse.status));

    state.apiBaseUrl = basePayload.baseUrl;
    if (currentApiNode) currentApiNode.textContent = shortApiNodeLabel(basePayload.baseUrl);
    apiSettingsResult.textContent = `已切换到 ${basePayload.baseUrl}`;
    await loadConfig();
    await loadApiSettings();
  } catch (error) {
    apiSettingsResult.textContent = '';
    apiSettingsError.textContent = error.message;
  } finally {
    saveApiBaseBtn.disabled = false;
  }
}

export function syncApiSettingsButton() {
  if (apiSettingsButton) apiSettingsButton.hidden = !state.isAdminUser;
  if (adminQuickActions) adminQuickActions.hidden = !state.isAdminUser;
  if (quickApiSettingsButton) quickApiSettingsButton.hidden = !state.isAdminUser;
  const sidebarButton = document.querySelector('#sidebarApiSettingsButton');
  if (sidebarButton) sidebarButton.hidden = !state.isAdminUser;
}

function shortApiNodeLabel(url) {
  if (!url) return '未配置';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
