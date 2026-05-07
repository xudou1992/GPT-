import { accessPassword } from '../config.js';
import { getCookie, createAccessToken } from '../utils.js';
import { sessions } from '../storage/index.js';

const accessCookieName = 'ias_access';
const sessionCookieName = 'ias_session';
const accessToken = accessPassword ? createAccessToken(accessPassword) : '';

export { accessCookieName, sessionCookieName, accessToken };

export function isAuthenticated(req) {
  if (getSessionUser(req)) return true;
  if (accessPassword && getCookie(req, accessCookieName) === accessToken) return true;
  return false;
}

export function isAdmin(req) {
  return Boolean(accessPassword && getCookie(req, accessCookieName) === accessToken);
}

export function getSessionUser(req) {
  if (accessPassword && getCookie(req, accessCookieName) === accessToken) return 'admin';
  const token = getCookie(req, sessionCookieName);
  if (!token) return null;
  const session = sessions.get(token);
  return session?.username || null;
}

export function requireAccess(req, res, next) {
  if (isAuthenticated(req)) { next(); return; }
  res.status(401).json({ error: '请先登录。' });
}

export function requireAdmin(req, res, next) {
  if (isAdmin(req)) { next(); return; }
  res.status(403).json({ error: '仅管理员可访问。' });
}
