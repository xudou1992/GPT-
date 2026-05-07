#!/usr/bin/env node
import { getBaseUrl } from './src/config.js';
import fs from 'node:fs';
import path from 'node:path';

const envText = fs.readFileSync('/opt/image-api-studio/.env', 'utf8');
const apiKey = envText.match(/OPENAI_API_KEY=(.+)/)?.[1]?.trim();
const baseUrl = getBaseUrl();

if (!apiKey) { console.error('❌ 未找到 OPENAI_API_KEY'); process.exit(1); }

console.log('API 节点:', baseUrl);
console.log('模型: gpt-image-2');
console.log('正在生成测试图片...');

const start = Date.now();
const res = await fetch(`${baseUrl}/images/generations`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  },
  body: JSON.stringify({
    model: 'gpt-image-2',
    prompt: 'A simple red circle on white background',
    size: '1024x1024',
    n: 1
  })
});

const data = await res.json();
const elapsed = Date.now() - start;

if (!res.ok) {
  console.error(`❌ 生成失败 HTTP ${res.status}`);
  console.error('响应:', JSON.stringify(data, null, 2));
  process.exit(1);
}

const item = data.data?.[0];
if (!item) {
  console.error('❌ 响应中没有图片数据');
  console.error('响应:', JSON.stringify(data, null, 2));
  process.exit(1);
}

const outDir = '/opt/image-api-studio/public/generated';
const filename = `test-generate-${Date.now()}.png`;
const outPath = path.join(outDir, filename);

let buffer;
if (item.b64_json) {
  buffer = Buffer.from(item.b64_json, 'base64');
} else if (item.url) {
  console.log('下载图片:', item.url);
  const imgRes = await fetch(item.url);
  if (!imgRes.ok) {
    console.error(`❌ 下载图片失败 HTTP ${imgRes.status}`);
    process.exit(1);
  }
  buffer = Buffer.from(await imgRes.arrayBuffer());
} else {
  console.error('❌ 没有 b64_json 或 url');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, buffer);
const size = fs.statSync(outPath).size;

console.log(`✅ 生成成功！`);
console.log(`   耗时: ${elapsed}ms`);
console.log(`   文件: ${outPath}`);
console.log(`   大小: ${(size / 1024).toFixed(1)} KB`);
console.log(`   Visit: http://localhost:3000/generated/${filename}`);

// 验证是有效图片
const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
if (!isPng) {
  console.error('⚠️ 警告: 文件可能不是有效的 PNG');
  process.exit(1);
}
console.log('✅ PNG 格式验证通过');
