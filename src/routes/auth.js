import { Router } from 'express';
import crypto from 'node:crypto';
import { accessPassword, allowRegistration } from '../config.js';
import { createSessionToken, hashPassword, isHttps, getCookie, createId } from '../utils.js';
import { logger } from '../logger.js';
import { accessCookieName, sessionCookieName, accessToken, requireAdmin, getSessionUser } from '../middleware/auth.js';
import { users, invites, sessions, persistUsers, persistInvites, persistSessions } from '../storage/index.js';

const router = Router();

router.post('/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码。' });

  if (username === 'admin') {
    if (!accessPassword) return res.status(401).json({ error: '未配置管理员密码。' });
    if (password !== accessPassword) return res.status(401).json({ error: '用户名或密码错误。' });
    res.cookie(accessCookieName, accessToken, {
      httpOnly: true, sameSite: 'lax', secure: isHttps(req), path: '/', maxAge: 30 * 24 * 60 * 60 * 1000
    });
    return res.json({ ok: true, user: 'admin' });
  }

  const user = users.find(u => u.username === username);
  if (!user || hashPassword(password, user.salt) !== user.passwordHash) {
    return res.status(401).json({ error: '用户名或密码错误。' });
  }

  const token = createSessionToken();
  sessions.set(token, { username: user.username, createdAt: Date.now() });
  await persistSessions();
  res.cookie(sessionCookieName, token, {
    httpOnly: true, sameSite: 'lax', secure: isHttps(req), path: '/', maxAge: 30 * 24 * 60 * 60 * 1000
  });
  res.json({ ok: true, user: user.username });
});

router.post('/register', async (req, res) => {
  if (!allowRegistration) return res.status(403).json({ error: '注册功能已关闭。' });

  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const code = String(req.body?.code || '').trim();

  if (!username || username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名需要 2-20 个字符。' });
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username)) return res.status(400).json({ error: '用户名只能包含字母、数字、下划线或中文。' });
  if (username.toLowerCase() === 'admin') return res.status(400).json({ error: '该用户名为保留字段。' });
  if (password.length < 6 || password.length > 64) return res.status(400).json({ error: '密码需要 6-64 个字符。' });
  if (!code) return res.status(400).json({ error: '请输入邀请码。' });

  const invite = invites.find(i => i.code === code);
  if (!invite) return res.status(403).json({ error: '邀请码无效。' });
  if (invite.usedAt) return res.status(403).json({ error: '该邀请码已被使用。' });
  if (users.some(u => u.username === username)) return res.status(409).json({ error: '该用户名已被注册。' });

  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: createId(), username, passwordHash: hashPassword(password, salt), salt,
    createdAt: new Date().toISOString(), invitedBy: invite.code
  };
  users.push(user);
  await persistUsers();

  invite.usedAt = new Date().toISOString();
  invite.usedBy = username;
  await persistInvites();

  const token = createSessionToken();
  sessions.set(token, { username: user.username, createdAt: Date.now() });
  await persistSessions();
  res.cookie(sessionCookieName, token, {
    httpOnly: true, sameSite: 'lax', secure: isHttps(req), path: '/', maxAge: 30 * 24 * 60 * 60 * 1000
  });
  logger.info('user', 'registered', { username, inviteCode: invite.code });
  res.status(201).json({ ok: true, user: user.username });
});

router.post('/logout', (req, res) => {
  const token = getCookie(req, sessionCookieName);
  if (token) { sessions.delete(token); persistSessions().catch(() => {}); }
  res.clearCookie(accessCookieName, { path: '/' });
  res.clearCookie(sessionCookieName, { path: '/' });
  res.json({ ok: true });
});

// ── Invite management (admin only) ──
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `IAS-${part(4)}-${part(4)}`;
}

router.get('/admin/invites', requireAdmin, (_req, res) => {
  res.json({ invites: invites.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
});

router.post('/admin/invites', requireAdmin, async (req, res) => {
  const count = Math.min(Math.max(Number(req.body?.count) || 1, 1), 20);
  const created = [];
  for (let i = 0; i < count; i++) {
    const invite = {
      code: generateInviteCode(), createdAt: new Date().toISOString(),
      createdBy: getSessionUser(req) || 'admin', usedAt: null, usedBy: null
    };
    invites.push(invite);
    created.push(invite);
  }
  await persistInvites();
  res.json({ created });
});

router.delete('/admin/invites/:code', requireAdmin, async (req, res) => {
  const idx = invites.findIndex(i => i.code === req.params.code);
  if (idx === -1) return res.status(404).json({ error: '邀请码不存在。' });
  if (invites[idx].usedAt) return res.status(400).json({ error: '已使用的邀请码不可删除。' });
  invites.splice(idx, 1);
  await persistInvites();
  res.status(204).end();
});

export default router;
