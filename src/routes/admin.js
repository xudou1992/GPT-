import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  dataDir, generatedDir, thumbsDir, uploadsDir, envFile, apiBasePresets,
  getBaseUrl, normalizeBaseUrl, setBaseUrl, getModels, getDefaultModel, setDefaultModel, getApiKey
} from '../config.js';
import { requireAdmin } from '../middleware/auth.js';
import { tasks, persistTasks, deleteTaskFiles } from '../storage/index.js';
import { formatBytes, normalizeApiError, summarizeText } from '../utils.js';

const router = Router();
router.use(requireAdmin);

router.get('/dashboard', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(DASHBOARD_HTML);
});

router.get('/dashboard.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.send(DASHBOARD_JS);
});

router.get('/storage', async (_req, res, next) => {
  try {
    const [data, generated, thumbs, uploads] = await Promise.all([
      directoryStats(dataDir),
      directoryStats(generatedDir),
      directoryStats(thumbsDir),
      directoryStats(uploadsDir)
    ]);
    res.json({
      directories: { data, generated, thumbs, uploads },
      tasks: summarizeTasks()
    });
  } catch (error) { next(error); }
});

router.get('/api-base', (_req, res) => {
  res.json({
    current: getBaseUrl(),
    presets: apiBasePresets
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
        ok: false,
        status: 0,
        elapsedMs: 0,
        hasData: false,
        modelSupported: false,
        firstModel: null,
        model,
        message: '服务端还没有配置 API Key。'
      });
    }
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${testKey}` },
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const listedModels = Array.isArray(json?.data) ? json.data.map(item => item?.id).filter(Boolean) : [];
    const listedSupport = listedModels.includes(model);
    res.json({
      ok: response.ok,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      hasData: Array.isArray(json?.data),
      modelSupported: response.ok ? listedSupport || listedModels.length === 0 : false,
      firstModel: json?.data?.[0]?.id || null,
      model,
      message: response.ok ? '' : (json ? normalizeApiError(json) : summarizeText(text))
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/api-base', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  try {
    const baseUrl = normalizeBaseUrl(url);
    const envText = await readEnvText();
    const lines = envText.split(/\r?\n/).filter(line => line && !line.startsWith('OPENAI_BASE_URL='));
    lines.push(`OPENAI_BASE_URL=${baseUrl}`);
    await fs.writeFile(envFile, `${lines.join('\n')}\n`, 'utf8');
    setBaseUrl(baseUrl);
    res.json({ ok: true, baseUrl });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/tasks/cleanup', async (req, res, next) => {
  try {
    const olderThanDays = clampDays(req.body?.olderThanDays);
    const statuses = normalizeStatuses(req.body?.statuses);
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const removable = tasks.filter(task => statuses.has(task.status) && taskTime(task) < cutoff);
    for (const task of removable) await deleteTaskFiles(task);
    if (removable.length) {
      const ids = new Set(removable.map(task => task.id));
      tasks.splice(0, tasks.length, ...tasks.filter(task => !ids.has(task.id)));
      await persistTasks();
    }
    res.json({ removed: removable.length, olderThanDays, statuses: [...statuses] });
  } catch (error) { next(error); }
});

router.get('/models', (_req, res) => {
  res.json({
    current: getDefaultModel(),
    models: getModels()
  });
});

router.post('/models', async (req, res) => {
  try {
    const defaultModel = String(req.body?.defaultModel || req.body?.default || '').trim();
    if (defaultModel && defaultModel !== 'gpt-image-2') return res.status(400).json({ error: '??????? gpt-image-2?' });
    if (!defaultModel) return res.status(400).json({ error: '默认模型不能为空。' });
    const envText = await readEnvText();
    const lines = envText.split(/\r?\n/).filter(line => line && !line.startsWith('IMAGE_MODEL=') && !line.startsWith('IMAGE_MODELS='));
    lines.push(`IMAGE_MODEL=${defaultModel}`);
    await fs.writeFile(envFile, `${lines.join('\n')}\n`, 'utf8');
    setDefaultModel(defaultModel);
    process.env.IMAGE_MODELS = '';
    res.json({ ok: true, defaultModel, models: [defaultModel] });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

async function readEnvText() {
  try {
    return await fs.readFile(envFile, 'utf8');
  } catch {
    return '';
  }
}

async function directoryStats(dir) {
  let files = 0;
  let bytes = 0;
  async function walk(current) {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) { await walk(fullPath); continue; }
      if (!entry.isFile()) continue;
      files += 1;
      bytes += (await fs.stat(fullPath)).size;
    }
  }
  await walk(dir);
  return { path: dir, files, bytes };
}

function summarizeTasks() {
  const byStatus = {};
  for (const task of tasks) byStatus[task.status] = (byStatus[task.status] || 0) + 1;
  return { total: tasks.length, byStatus };
}

function clampDays(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 30;
  return Math.max(1, Math.min(3650, Math.round(number)));
}

function normalizeStatuses(value) {
  const allowed = new Set(['succeeded', 'failed', 'canceled']);
  const list = Array.isArray(value) ? value : [];
  const selected = new Set(list.filter(status => allowed.has(status)));
  return selected.size ? selected : allowed;
}

function taskTime(task) {
  return Date.parse(task.completedAt || task.updatedAt || task.createdAt || '') || 0;
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>管理员面板 | Image API Studio</title>
<style>
:root{color-scheme:light;--bg:#f4f5f7;--surface:#fff;--card:#fff;--card-hover:#f8fafc;--border:#e2e7ef;--border-strong:#cbd5e1;--text:#111827;--text-muted:#64748b;--accent:#0f172a;--accent-light:#334155;--success:#16a34a;--warning:#d97706;--danger:#dc2626;--info:#2563eb;--shadow:0 14px 40px rgba(31,41,55,.08)}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;line-height:1.5}
a{color:var(--text);text-decoration:none;transition:color .2s,background .2s,border-color .2s}a:hover{color:var(--accent-light)}
.wrap{max-width:1280px;margin:0 auto;padding:18px}

/* Header */
.header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:18px;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:var(--shadow);padding:18px 22px}
.header-left{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.back-btn{display:flex;align-items:center;gap:8px;padding:10px 14px;background:#f8fafc;border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px;font-weight:700;transition:all .2s}
.back-btn:hover{background:#eef2f7;border-color:var(--border-strong)}
.header h1{font-size:24px;font-weight:800;color:var(--text);letter-spacing:0}
.header-meta{color:var(--text-muted);font-size:13px;font-weight:600}
.refresh-btn{display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px;font-weight:700;cursor:pointer;transition:all .2s}
.refresh-btn:hover{background:#f8fafc;border-color:var(--border-strong)}
.refresh-btn.spinning svg{animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* Grid */
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:18px}

/* Cards */
.card{grid-column:span 12;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:22px;box-shadow:var(--shadow);transition:border-color .2s,box-shadow .2s}
.card:hover{border-color:var(--border-strong);box-shadow:0 18px 44px rgba(31,41,55,.1)}
.card h2{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:800;margin-bottom:18px;color:var(--text)}
.card h2::before{content:'';width:3px;height:16px;background:var(--accent);border-radius:2px}

/* Status Grid */
.status-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px}
.status-item{background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:18px;text-align:left;transition:border-color .2s,background .2s}
.status-item:hover{background:#fff;border-color:var(--border-strong)}
.status-item .icon{align-items:center;background:#fff;border:1px solid var(--border);border-radius:8px;color:var(--text-muted);display:inline-flex;font-size:15px;font-weight:800;height:32px;justify-content:center;margin-bottom:10px;width:32px}
.status-item .value{font-size:22px;font-weight:800;color:var(--text);margin-bottom:2px;word-break:break-word}
.status-item .label{color:var(--text-muted);font-size:13px;font-weight:700}
.status-item.success .icon{color:var(--success);border-color:#bbf7d0;background:#f0fdf4}
.status-item.warning .icon{color:var(--warning);border-color:#fed7aa;background:#fff7ed}
.status-item.danger .icon{color:var(--danger);border-color:#fecaca;background:#fef2f2}
.status-item.info .icon{color:var(--info);border-color:#bfdbfe;background:#eff6ff}

/* Split Card */
.card-split{grid-column:span 12;display:grid;grid-template-columns:1fr 1fr;gap:24px}
.card-split .section h3{font-size:13px;font-weight:800;color:var(--text-muted);margin-bottom:14px;text-transform:none;letter-spacing:0}

/* Stats Table */
.stats-table{width:100%;border-collapse:collapse}
.stats-table td{padding:11px 0;border-bottom:1px solid var(--border)}
.stats-table tr:last-child td{border-bottom:none}
.stats-table .stat-name{color:var(--text-muted);font-size:13px;font-weight:700}
.stats-table .stat-value{color:var(--text);font-size:14px;font-weight:800;text-align:right}
.stats-table .stat-bar{width:80px;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;margin-left:auto}
.stats-table .stat-bar-fill{height:100%;background:var(--accent);border-radius:3px;transition:width .5s ease}

/* Forms */
.form-row{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;margin-top:16px}
.form-field{display:flex;flex-direction:column;gap:8px;flex:1;min-width:200px}
.form-field label{color:var(--text-muted);font-size:13px;font-weight:800}
.form-field input,.form-field select{background:#fff;border:1px solid #d9e0eb;border-radius:8px;padding:12px 14px;color:var(--text);font-size:14px;transition:all .2s}
.form-field input:focus,.form-field select:focus{outline:none;border-color:var(--info);box-shadow:0 0 0 3px rgba(37,99,235,.14)}
.form-field input::placeholder{color:var(--text-muted)}

/* Current Value Box */
.current-box{background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:15px 16px;margin-bottom:16px}
.current-box .label{color:var(--text-muted);font-size:12px;font-weight:800;margin-bottom:4px}
.current-box .value{font-size:14px;font-weight:800;color:var(--text);word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}

/* Buttons */
.btn-group{display:flex;gap:12px;flex-wrap:wrap;justify-content:flex-end;margin-top:20px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:11px 18px;border-radius:8px;font-size:14px;font-weight:800;cursor:pointer;transition:all .2s;border:none}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:#1e293b;box-shadow:0 10px 24px rgba(15,23,42,.18)}
.btn-secondary{background:#fff;color:var(--text);border:1px solid var(--border)}
.btn-secondary:hover{background:#f8fafc;border-color:var(--border-strong)}
.btn-danger{background:#fff;color:var(--danger);border:1px solid #fecaca}
.btn-danger:hover{background:#fef2f2;border-color:#fca5a5}
.btn:disabled{opacity:.6;cursor:not-allowed}

/* Result Messages */
.result-box{margin-top:16px;padding:12px 14px;border-radius:8px;font-size:13px;font-weight:700;display:flex;align-items:center;gap:10px}
.result-box.success{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0}
.result-box.error{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
.result-box.info{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe}

/* Node Presets */
.preset-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:16px}
.preset-item{background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:16px;cursor:pointer;transition:all .2s}
.preset-item:hover{border-color:var(--border-strong);background:#fff}
.preset-item.active{border-color:var(--accent);background:#eef2f7}
.preset-item .name{font-weight:800;color:var(--text);margin-bottom:4px}
.preset-item .url{font-size:12px;color:var(--text-muted);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.preset-item .status{font-size:11px;font-weight:800;margin-top:8px;padding:4px 8px;border-radius:6px;display:inline-block}
.preset-item .status.ok{background:#dcfce7;color:#166534}
.preset-item .status.fail{background:#fee2e2;color:#991b1b}

/* Loading Spinner */
.spinner{width:16px;height:16px;border:2px solid #cbd5e1;border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite}

/* Responsive */
@media (min-width:980px){.grid>.card:nth-child(3),.grid>.card:nth-child(4){grid-column:span 6}.grid>.card:nth-child(5),.grid>.card:nth-child(6){grid-column:span 6}}
@media (max-width:900px){.header{align-items:flex-start;flex-direction:column}.card-split{grid-template-columns:1fr}.grid{gap:14px}.wrap{padding:12px}}
@media (max-width:600px){.status-grid{grid-template-columns:1fr}.preset-grid{grid-template-columns:1fr}.btn-group{justify-content:stretch}.btn{justify-content:center;width:100%}.header-left{align-items:flex-start;flex-direction:column}.card{padding:16px}}
</style></head><body>
<div class="wrap">
  <header class="header">
    <div class="header-left">
      <a href="/" class="back-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        返回首页
      </a>
      <div>
        <h1>管理员面板</h1>
        <div class="header-meta">Image API Studio · 系统管理与监控</div>
      </div>
    </div>
    <button class="refresh-btn" id="refreshBtn" title="刷新数据">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
      刷新
    </button>
  </header>

  <div class="grid">
    <!-- 服务状态 -->
    <section class="card">
      <h2>服务状态</h2>
      <div id="health" class="status-grid">
        <div class="status-item"><div class="spinner" style="margin:20px auto"></div></div>
      </div>
    </section>

    <!-- 存储与任务统计 -->
    <section class="card card-split">
      <div class="section">
        <h3>存储统计</h3>
        <table class="stats-table" id="storage">
          <tr><td colspan="2" style="text-align:center;padding:20px"><div class="spinner"></div></td></tr>
        </table>
      </div>
      <div class="section">
        <h3>任务统计</h3>
        <table class="stats-table" id="tasks">
          <tr><td colspan="2" style="text-align:center;padding:20px"><div class="spinner"></div></td></tr>
        </table>
      </div>
    </section>

    <!-- API Key 设置 -->
    <section class="card">
      <h2>API Key 设置</h2>
      <div class="current-box">
        <div class="label">当前 Key</div>
        <div class="value" id="currentKey">--</div>
      </div>
      <div class="form-row">
        <div class="form-field" style="flex:1">
          <label>自定义 API Key（以 sk- 开头）</label>
          <input id="apiKeyInput" type="password" placeholder="sk-xxxxxxxxxxxxxxxxxxxxxxxx" />
        </div>
      </div>
      <div class="btn-group">
        <button class="btn btn-secondary" id="showKeyBtn">显示</button>
        <button class="btn btn-primary" id="saveKeyBtn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          保存 Key
        </button>
      </div>
      <div id="keyResult"></div>
    </section>

    <!-- API 节点设置 -->
    <section class="card">
      <h2>API 节点设置</h2>
      <div class="current-box">
        <div class="label">当前节点</div>
        <div class="value" id="currentBase">--</div>
      </div>
      
      <div class="form-row">
        <div class="form-field" style="flex:2">
          <label>预设节点</label>
          <select id="baseSelect">
            <option>加载中...</option>
          </select>
        </div>
        <div class="form-field" style="flex:3">
          <label>自定义地址</label>
          <input id="customBase" type="url" placeholder="https://api.example.com/v1" />
        </div>
      </div>
      
      <div class="btn-group">
        <button class="btn btn-secondary" id="testBaseBtn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
          测试节点
        </button>
        <button class="btn btn-primary" id="saveBaseBtn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          保存切换
        </button>
      </div>
      <div id="baseResult"></div>
    </section>

    <!-- 模型配置 -->
    <section class="card">
      <h2>模型配置</h2>
      <div class="current-box">
        <div class="label">当前模型</div>
        <div class="value" id="currentModel">--</div>
      </div>
      <div style="color:var(--text-muted);font-size:13px;font-weight:700;margin-bottom:16px">
        当前运行模型为 <code style="background:#eef2f7;color:var(--text);padding:2px 8px;border-radius:4px">gpt-image-2</code>，节点需支持此模型才能正常生图。
      </div>
      <div id="modelsResult"></div>
    </section>

    <!-- 清理旧任务 -->
    <section class="card">
      <h2>清理旧任务</h2>
      <div class="form-row">
        <div class="form-field" style="flex:0 0 auto;min-width:120px">
          <label>清理天数</label>
          <input type="number" id="days" value="30" min="1" max="365">
        </div>
        <div class="form-field" style="flex:2">
          <label>任务状态</label>
          <select id="statuses" multiple size="3">
            <option value="succeeded" selected>✓ 已完成</option>
            <option value="failed" selected>✗ 已失败</option>
            <option value="canceled" selected>⊘ 已取消</option>
          </select>
        </div>
      </div>
      <div class="btn-group">
        <button class="btn btn-danger" id="cleanupBtn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
          执行清理
        </button>
      </div>
      <div id="cleanupResult"></div>
    </section>
  </div>
</div>
<script src="/api/admin/dashboard.js" defer></script></body></html>`;

const DASHBOARD_JS = `
const el = (id) => document.getElementById(id);
const fmtBytes = (b) => b >= 1024 * 1024 * 1024 ? (b / 1024 / 1024 / 1024).toFixed(1) + ' GB' : b >= 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + ' MB' : b >= 1024 ? (b / 1024).toFixed(1) + ' KB' : b + ' B';
const fmtTime = (s) => s >= 86400 ? Math.floor(s/86400) + '天' : s >= 3600 ? Math.floor(s/3600) + '小时' : Math.floor(s/60) + '分钟';
let presets = [];
let currentModel = '';
let refreshInterval = null;

async function readJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: text || '非 JSON 响应' }; }
}

// 状态图标
const icons = {
  success: '✓', warning: '⚠', danger: '✗', info: 'ℹ',
  server: 'OK', model: 'AI', node: 'JS', clock: 'UP',
  storage: 'GB', tasks: 'TS', image: 'IM', thumb: 'TH'
};

// 显示结果消息
function showResult(id, type, message) {
  const box = el(id);
  if (!box) return;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ';
  box.innerHTML = '<div class="result-box ' + type + '"><span>' + icon + '</span>' + message + '</div>';
  if (type !== 'error') setTimeout(() => { box.innerHTML = ''; }, 5000);
}

// 加载服务状态
async function loadStats() {
  try {
    const [healthRes, storageRes] = await Promise.all([
      fetch('/api/health'),
      fetch('/api/admin/storage')
    ]);
    const health = await readJson(healthRes);
    const storage = await readJson(storageRes);

    // 服务状态卡片
    const statusClass = health.ok ? 'success' : 'danger';
    el('health').innerHTML = '' +
      '<div class="status-item ' + statusClass + '"><div class="icon">' + icons.server + '</div><div class="value">' + (health.ok ? '运行中' : '异常') + '</div><div class="label">服务状态</div></div>' +
      '<div class="status-item info"><div class="icon">' + icons.model + '</div><div class="value">' + (health.model || '--') + '</div><div class="label">当前模型</div></div>' +
      '<div class="status-item info"><div class="icon">' + icons.node + '</div><div class="value">' + (health.nodeVersion || '--') + '</div><div class="label">Node版本</div></div>' +
      '<div class="status-item info"><div class="icon">' + icons.clock + '</div><div class="value">' + fmtTime(health.uptimeSeconds || 0) + '</div><div class="label">运行时间</div></div>' +
      '<div class="status-item info"><div class="icon">' + icons.tasks + '</div><div class="value">' + (health.tasks || 0) + '</div><div class="label">任务总数</div></div>';

    // 存储统计
    const d = storage.directories || {};
    const totalBytes = Object.values(d).reduce((a, v) => a + (v.bytes || 0), 0);
    const totalFiles = Object.values(d).reduce((a, v) => a + (v.files || 0), 0);
    el('storage').innerHTML = Object.entries(d).map(([k, v]) =>
      '<tr><td class="stat-name">' + k + '</td><td class="stat-value">' + fmtBytes(v.bytes || 0) + ' <span style="color:var(--text-muted)">(' + (v.files || 0) + ' 文件)</span></td></tr>'
    ).join('') +
      '<tr style="border-top:2px solid var(--border)"><td class="stat-name" style="font-weight:600">总计</td><td class="stat-value" style="font-weight:600">' + fmtBytes(totalBytes) + ' <span style="color:var(--text-muted)">(' + totalFiles + ' 文件)</span></td></tr>';

    // 任务统计
    const t = storage.tasks || {};
    const byStatus = t.byStatus || {};
    el('tasks').innerHTML = '' +
      '<tr><td class="stat-name">总任务</td><td class="stat-value">' + (t.total || 0) + '</td></tr>' +
      '<tr><td class="stat-name">进行中</td><td class="stat-value" style="color:var(--info)">' + (byStatus.running || 0) + '</td></tr>' +
      '<tr><td class="stat-name">已完成</td><td class="stat-value" style="color:var(--success)">' + (byStatus.succeeded || 0) + '</td></tr>' +
      '<tr><td class="stat-name">失败</td><td class="stat-value" style="color:var(--danger)">' + (byStatus.failed || 0) + '</td></tr>' +
      '<tr><td class="stat-name">待处理</td><td class="stat-value" style="color:var(--warning)">' + (byStatus.pending || 0) + '</td></tr>';
  } catch (e) {
    el('health').innerHTML = '<div class="status-item danger"><div class="icon">' + icons.danger + '</div><div class="value">加载失败</div><div class="label">' + e.message + '</div></div>';
  }
}

// 加载节点配置
async function loadBase() {
  try {
    const r = await fetch('/api/admin/settings/api-base');
    const j = await readJson(r);
    if (!r.ok) throw new Error(j.error || '加载失败');
    presets = j.presets || [];
    currentModel = j.currentModel || '';
    el('currentBase').textContent = j.current || '--';

    const select = el('baseSelect');
    select.replaceChildren();
    for (const preset of presets) {
      const opt = document.createElement('option');
      opt.value = preset.value;
      opt.textContent = preset.label;
      select.append(opt);
    }
    const custom = document.createElement('option');
    custom.value = '__custom__';
    custom.textContent = '自定义地址...';
    select.append(custom);
    select.value = presets.some(p => p.value === j.current) ? j.current : '__custom__';
    el('customBase').value = presets.some(p => p.value === j.current) ? '' : (j.current || '');
    el('customBase').style.display = select.value !== '__custom__' ? 'none' : 'block';
  } catch (e) {
    showResult('baseResult', 'error', e.message);
  }
}

// 测试节点
async function testBase() {
  const btn = el('testBaseBtn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> 测试中...';
  try {
    const url = el('baseSelect').value === '__custom__' ? el('customBase').value.trim() : el('baseSelect').value;
    if (!url) throw new Error('请选择或输入节点地址');
    const r = await fetch('/api/admin/settings/api-base/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, key: el('apiKeyInput').value.trim(), model: currentModel || 'gpt-image-2' })
    });
    const j = await readJson(r);
    if (!r.ok) throw new Error(j.error || '测试失败');

    if (j.ok && j.modelSupported) {
      showResult('baseResult', 'success', '节点可用 · HTTP ' + j.status + ' · ' + j.elapsedMs + 'ms · ✅ 支持 ' + j.model);
    } else if (j.ok && !j.modelSupported) {
      showResult('baseResult', 'error', '节点可用但不支持当前模型 · ❌ ' + j.model + ' · ' + (j.message || ''));
    } else {
      showResult('baseResult', 'error', '节点异常 · HTTP ' + j.status + ' · ' + (j.message || ''));
    }
  } catch (e) {
    showResult('baseResult', 'error', e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg> 测试节点';
  }
}

// 加载 API Key
async function loadApiKey() {
  try {
    const r = await fetch('/api/admin/settings/api-key');
    const j = await readJson(r);
    if (!r.ok) throw new Error(j.error || '加载失败');
    el('currentKey').textContent = j.hasCustom ? '已配置自定义 Key' : '使用环境变量 (' + j.envKeyPrefix + ')';
    if (j.hasCustom) el('apiKeyInput').value = j.current;
  } catch (e) {
    el('currentKey').textContent = '加载失败';
  }
}

// 保存 API Key
async function saveApiKey() {
  const btn = el('saveKeyBtn');
  btn.disabled = true;
  try {
    const key = el('apiKeyInput').value.trim();
    const r = await fetch('/api/admin/settings/api-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const j = await readJson(r);
    if (!r.ok) throw new Error(j.error || '保存失败');
    showResult('keyResult', 'success', key ? '已保存自定义 API Key' : '已清除自定义 API Key，恢复使用环境变量');
    await loadApiKey();
  } catch (e) {
    showResult('keyResult', 'error', e.message);
  } finally {
    btn.disabled = false;
  }
}

// 显示/隐藏 API Key
el('showKeyBtn').addEventListener('click', () => {
  const input = el('apiKeyInput');
  if (input.type === 'password') { input.type = 'text'; el('showKeyBtn').textContent = '隐藏'; }
  else { input.type = 'password'; el('showKeyBtn').textContent = '显示'; }
});

// 保存节点
async function saveBase() {
  const btn = el('saveBaseBtn');
  btn.disabled = true;
  try {
    const url = el('baseSelect').value === '__custom__' ? el('customBase').value.trim() : el('baseSelect').value;
    if (!url) throw new Error('请选择或输入节点地址');
    const r = await fetch('/api/admin/settings/api-base', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const j = await readJson(r);
    if (!r.ok) throw new Error(j.error || '保存失败');
    el('currentBase').textContent = j.baseUrl;
    showResult('baseResult', 'success', '已切换到: ' + j.baseUrl);
    await loadBase();
  } catch (e) {
    showResult('baseResult', 'error', e.message);
  } finally {
    btn.disabled = false;
  }
}

// 加载模型配置
async function loadModels() {
  try {
    const r = await fetch('/api/admin/settings/models');
    const j = await readJson(r);
    if (!r.ok) throw new Error(j.error || '加载模型失败');
    const current = j.current || j.defaultModel || j.model || '--';
    currentModel = current === '--' ? '' : current;
    el('currentModel').textContent = current;
    el('modelsResult').innerHTML = '';
  } catch (e) {
    showResult('modelsResult', 'error', e.message);
  }
}

// 清理任务
async function cleanup() {
  const btn = el('cleanupBtn');
  btn.disabled = true;
  try {
    const days = Number(el('days').value) || 30;
    const statuses = [...el('statuses').selectedOptions].map(o => o.value);
    const r = await fetch('/api/admin/tasks/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ olderThanDays: days, statuses })
    });
    const j = await readJson(r);
    if (!r.ok) throw new Error(j.error || '清理失败');
    showResult('cleanupResult', 'success', '已清理 ' + j.removed + ' 个任务');
    await loadStats();
  } catch (e) {
    showResult('cleanupResult', 'error', e.message);
  } finally {
    btn.disabled = false;
  }
}

// 刷新所有数据
async function refreshAll() {
  const btn = el('refreshBtn');
  btn.classList.add('spinning');
  await Promise.all([loadStats(), loadBase(), loadModels()]);
  setTimeout(() => btn.classList.remove('spinning'), 500);
}

// 启动自动刷新
function startAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(loadStats, 30000); // 每30秒刷新状态
}

// 事件监听
el('baseSelect').addEventListener('change', () => {
  el('customBase').style.display = el('baseSelect').value !== '__custom__' ? 'none' : 'block';
});
el('testBaseBtn').addEventListener('click', testBase);
el('saveBaseBtn').addEventListener('click', saveBase);
el('saveKeyBtn').addEventListener('click', saveApiKey);
el('cleanupBtn').addEventListener('click', cleanup);
el('refreshBtn').addEventListener('click', refreshAll);

// 初始化
async function init() {
  await refreshAll();
  await loadApiKey();
  startAutoRefresh();
}
init().catch(e => console.error('初始化失败:', e));
`;

export default router;
