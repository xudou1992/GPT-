import { describe, it, expect } from 'vitest';
import {
  createId, createSessionToken, createAccessToken, hashPassword,
  normalizeSize, formatBytes, summarizeText, normalizeApiError,
  describeFetchError, clampInteger, sortTasks, isRetryableImageError, isPermanentImageError,
  isSupportedUploadMime, extensionFromMime, createLimiter
} from '../src/utils.js';

describe('createId', () => {
  it('returns a 20-char hex string', () => {
    const id = createId();
    expect(id).toMatch(/^[0-9a-f]{20}$/);
  });

  it('returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createId()));
    expect(ids.size).toBe(100);
  });
});

describe('createSessionToken', () => {
  it('returns a 64-char hex string', () => {
    expect(createSessionToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createAccessToken', () => {
  it('is deterministic for same password', () => {
    expect(createAccessToken('test')).toBe(createAccessToken('test'));
  });

  it('differs for different passwords', () => {
    expect(createAccessToken('a')).not.toBe(createAccessToken('b'));
  });
});

describe('hashPassword', () => {
  it('is deterministic', () => {
    expect(hashPassword('pw', 'salt')).toBe(hashPassword('pw', 'salt'));
  });

  it('differs with different salt', () => {
    expect(hashPassword('pw', 'salt1')).not.toBe(hashPassword('pw', 'salt2'));
  });
});

describe('normalizeSize', () => {
  it('accepts allowed sizes', () => {
    expect(normalizeSize('3840x2160')).toEqual({ value: '3840x2160' });
  });

  it('defaults to 1024x1024 when empty', () => {
    expect(normalizeSize('')).toEqual({ value: '1024x1024' });
    expect(normalizeSize(null)).toEqual({ value: '1024x1024' });
  });

  it('rejects invalid format', () => {
    expect(normalizeSize('abc')).toHaveProperty('error');
    expect(normalizeSize('100')).toHaveProperty('error');
  });

  it('validates custom sizes', () => {
    expect(normalizeSize('1024x1024')).toEqual({ value: '1024x1024' });
  });

  it('rejects non-16-multiple', () => {
    expect(normalizeSize('1025x1024')).toHaveProperty('error');
  });

  it('rejects too small', () => {
    expect(normalizeSize('8x8')).toHaveProperty('error');
  });
});

describe('formatBytes', () => {
  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500B');
  });

  it('formats KB', () => {
    expect(formatBytes(2048)).toBe('2KB');
  });

  it('formats MB', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5MB');
  });
});

describe('summarizeText', () => {
  it('strips HTML tags', () => {
    expect(summarizeText('<b>hello</b>')).toBe('hello');
  });

  it('trims and truncates', () => {
    const long = 'a'.repeat(600);
    expect(summarizeText(long).length).toBe(500);
  });

  it('returns fallback for empty', () => {
    expect(summarizeText('')).toBe('上游接口返回了非 JSON 响应。');
  });
});

describe('normalizeApiError', () => {
  it('extracts string error', () => {
    expect(normalizeApiError({ error: 'bad request' })).toBe('bad request');
  });

  it('extracts nested error message', () => {
    expect(normalizeApiError({ error: { message: 'nested' } })).toBe('nested');
  });

  it('extracts top-level provider messages', () => {
    expect(normalizeApiError({ message: 'top level failure' })).toBe('top level failure');
  });

  it('maps cloudflare 524 to a helpful message', () => {
    expect(normalizeApiError({ error: 'galcraft.top | 524: A timeout occurred' })).toBe('上游节点响应超时（Cloudflare 524），请稍后重试，或切换到其他 API 节点。');
  });

  it('maps unavailable model channel to a helpful message', () => {
    expect(normalizeApiError({ error: { message: 'No available channel for model gpt-image-2' } })).toContain('当前节点未开通 gpt-image-2 生图通道');
  });

  it('maps insufficient quota to a helpful message', () => {
    expect(normalizeApiError({ error: { message: '用户额度不足, 剩余额度: ＄0.000000' }, code: 'insufficient_user_quota' })).toContain('当前 API Key 额度不足');
  });

  it('maps missing token group to a helpful message', () => {
    expect(normalizeApiError({ error: { message: '令牌未配置可用分组' } })).toContain('当前 API Key 没有配置可用分组');
  });

  it('maps busy image auths to a helpful message', () => {
    expect(normalizeApiError({ error: { message: 'all eligible image generation auths are busy' }, code: 'image_auth_busy' })).toContain('上游生图账号繁忙');
  });

  it('returns default for unknown shape', () => {
    expect(normalizeApiError({})).toBe('图片 API 返回了错误，请查看 details。');
  });
});

describe('describeFetchError', () => {
  it('handles non-Error', () => {
    expect(describeFetchError('timeout')).toBe('timeout');
  });

  it('includes cause info', () => {
    const error = new Error('fetch failed');
    error.cause = { code: 'ECONNRESET', message: 'reset' };
    const result = describeFetchError(error);
    expect(result).toContain('ECONNRESET');
    expect(result).toContain('reset');
  });
});

describe('clampInteger', () => {
  it('clamps within range', () => {
    expect(clampInteger(5, { min: 1, max: 10, fallback: 3 })).toBe(5);
  });

  it('clamps below min', () => {
    expect(clampInteger(-1, { min: 1, max: 10, fallback: 3 })).toBe(1);
  });

  it('uses fallback for NaN', () => {
    expect(clampInteger('abc', { min: 1, max: 10, fallback: 3 })).toBe(3);
  });
});

describe('sortTasks', () => {
  it('sorts by updatedAt descending', () => {
    const tasks = [
      { id: '1', updatedAt: '2024-01-01T00:00:00Z', createdAt: '2024-01-01T00:00:00Z' },
      { id: '2', updatedAt: '2024-06-01T00:00:00Z', createdAt: '2024-06-01T00:00:00Z' },
      { id: '3', updatedAt: '2024-03-01T00:00:00Z', createdAt: '2024-03-01T00:00:00Z' }
    ];
    const sorted = sortTasks(tasks);
    expect(sorted.map(t => t.id)).toEqual(['2', '3', '1']);
  });

  it('does not mutate original', () => {
    const tasks = [{ id: '1', updatedAt: '2024-01-01', createdAt: '2024-01-01' }];
    const sorted = sortTasks(tasks);
    expect(sorted).not.toBe(tasks);
  });
});

describe('isRetryableImageError', () => {
  it('matches timeout errors', () => {
    expect(isRetryableImageError('Connect Timeout Error')).toBe(true);
    expect(isRetryableImageError('ETIMEDOUT')).toBe(true);
  });

  it('matches upstream socket disconnects', () => {
    expect(isRetryableImageError('fetch failed; code=UND_ERR_SOCKET; cause=other side closed')).toBe(true);
  });

  it('matches 5xx', () => {
    expect(isRetryableImageError('HTTP 502')).toBe(true);
  });

  it('does not treat request ids as 5xx errors', () => {
    expect(isRetryableImageError('用户额度不足 (request id: 20260506154418834719470cI3hnRYa)')).toBe(false);
  });

  it('does not match bare 5xx-looking digits', () => {
    expect(isRetryableImageError('request id 202605061544')).toBe(false);
  });

  it('does not match 4xx', () => {
    expect(isRetryableImageError('HTTP 400 Bad Request')).toBe(false);
  });
});

describe('isPermanentImageError', () => {
  it('matches quota and model configuration failures', () => {
    expect(isPermanentImageError('用户额度不足, 剩余额度: ＄0.000000')).toBe(true);
    expect(isPermanentImageError('令牌未配置可用分组')).toBe(true);
    expect(isPermanentImageError('No available channel for model gpt-image-2')).toBe(true);
  });

  it('does not match transient transport errors', () => {
    expect(isPermanentImageError('fetch failed; code=UND_ERR_SOCKET')).toBe(false);
  });
});

describe('isSupportedUploadMime', () => {
  it('accepts PNG/JPEG/WebP', () => {
    expect(isSupportedUploadMime('image/png')).toBe(true);
    expect(isSupportedUploadMime('image/jpeg')).toBe(true);
    expect(isSupportedUploadMime('image/webp')).toBe(true);
  });

  it('rejects unsupported', () => {
    expect(isSupportedUploadMime('image/gif')).toBe(false);
    expect(isSupportedUploadMime('text/plain')).toBe(false);
  });
});

describe('extensionFromMime', () => {
  it('maps MIME to extension', () => {
    expect(extensionFromMime('image/jpeg')).toBe('jpg');
    expect(extensionFromMime('image/webp')).toBe('webp');
    expect(extensionFromMime('image/png')).toBe('png');
    expect(extensionFromMime()).toBe('png');
  });
});

describe('createLimiter', () => {
  it('limits concurrency', async () => {
    let running = 0;
    let maxRunning = 0;
    const limiter = createLimiter(2);
    const job = () => limiter(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 50));
      running--;
    });
    await Promise.all(Array.from({ length: 5 }, () => job()));
    expect(maxRunning).toBe(2);
  });
});
