import { describe, it, expect } from 'vitest';
import { createAccessToken, hashPassword, getCookie } from '../src/utils.js';

describe('auth utilities', () => {
  describe('createAccessToken', () => {
    it('produces consistent sha256 hash', () => {
      const token = createAccessToken('mypassword');
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(token).toBe(createAccessToken('mypassword'));
    });
  });

  describe('hashPassword', () => {
    it('produces consistent sha256 hash with salt', () => {
      const hash = hashPassword('secret', 'randomsalt');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).toBe(hashPassword('secret', 'randomsalt'));
    });

    it('different salt produces different hash', () => {
      expect(hashPassword('pw', 'a')).not.toBe(hashPassword('pw', 'b'));
    });

    it('different password produces different hash', () => {
      expect(hashPassword('pw1', 'salt')).not.toBe(hashPassword('pw2', 'salt'));
    });
  });

  describe('getCookie', () => {
    function makeReq(cookieHeader) {
      return { headers: { cookie: cookieHeader } };
    }

    it('parses simple cookie', () => {
      expect(getCookie(makeReq('name=value'), 'name')).toBe('value');
    });

    it('parses multiple cookies', () => {
      expect(getCookie(makeReq('a=1; b=2; c=3'), 'b')).toBe('2');
    });

    it('returns empty string for missing cookie', () => {
      expect(getCookie(makeReq('a=1'), 'missing')).toBe('');
    });

    it('handles encoded values', () => {
      expect(getCookie(makeReq('name=%E4%BD%A0%E5%A5%BD'), 'name')).toBe('你好');
    });

    it('handles empty cookie header', () => {
      expect(getCookie(makeReq(''), 'name')).toBe('');
      expect(getCookie({ headers: {} }, 'name')).toBe('');
    });

    it('handles cookie with = in value', () => {
      expect(getCookie(makeReq('token=abc=def=ghi'), 'token')).toBe('abc=def=ghi');
    });
  });
});
