import { describe, it, expect } from 'vitest';
import {
  port, baseUrl, defaultModel, models, sizes, allowedSizes,
  qualities, backgrounds, formats, taskStatuses, taskModes,
  uploadMimeTypes, minEdge, maxEdge, maxPixels,
  maxTaskImages, maxTaskConcurrency, maxPromptLength,
  dataDir, generatedDir, publicDir
} from '../src/config.js';

describe('config', () => {
  it('has a valid port', () => {
    expect(port).toBeGreaterThanOrEqual(1);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('has a base URL', () => {
    expect(baseUrl).toMatch(/^https?:\/\//);
    expect(baseUrl).not.toMatch(/\/$/);
  });

  it('has a default model', () => {
    expect(defaultModel).toBeTruthy();
    expect(models).toContain(defaultModel);
  });

  it('has no duplicate models', () => {
    expect(new Set(models).size).toBe(models.length);
  });

  it('has sizes', () => {
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) {
      expect(allowedSizes.has(size)).toBe(true);
    }
  });

  it('has valid quality/background/format sets', () => {
    expect(qualities.has('auto')).toBe(true);
    expect(backgrounds.has('transparent')).toBe(true);
    expect(formats.has('png')).toBe(true);
  });

  it('has valid status/mode sets', () => {
    expect(taskStatuses.has('all')).toBe(true);
    expect(taskStatuses.has('pending')).toBe(true);
    expect(taskModes.has('text')).toBe(true);
    expect(taskModes.has('image')).toBe(true);
  });

  it('has valid upload MIME types', () => {
    expect(uploadMimeTypes.has('image/png')).toBe(true);
    expect(uploadMimeTypes.has('image/jpeg')).toBe(true);
    expect(uploadMimeTypes.has('image/webp')).toBe(true);
  });

  it('has sane numeric limits', () => {
    expect(minEdge).toBeGreaterThanOrEqual(16);
    expect(maxEdge).toBeGreaterThanOrEqual(minEdge);
    expect(maxPixels).toBeGreaterThanOrEqual(minEdge * minEdge);
    expect(maxTaskImages).toBeGreaterThanOrEqual(1);
    expect(maxTaskConcurrency).toBeGreaterThanOrEqual(1);
    expect(maxPromptLength).toBeGreaterThanOrEqual(3);
  });

  it('has valid directory paths', () => {
    expect(dataDir).toBeTruthy();
    expect(generatedDir).toBeTruthy();
    expect(publicDir).toBeTruthy();
  });
});
