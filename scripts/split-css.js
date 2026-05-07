/**
 * One-time script: split public/styles.css into modular CSS files.
 * Run: node scripts/split-css.js
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'public/styles.css';
const OUT = 'client/src/styles';

const css = fs.readFileSync(SRC, 'utf8');

// ── Tokenize into top-level blocks ──
function tokenize(source) {
  const blocks = [];
  let i = 0;
  while (i < source.length) {
    // Skip whitespace
    while (i < source.length && /\s/.test(source[i])) i++;
    if (i >= source.length) break;

    // Find selector/at-rule start
    const start = i;
    let depth = 0;
    let inString = false;
    let stringChar = '';

    // Read until we close the top-level block
    while (i < source.length) {
      const ch = source[i];
      if (inString) {
        if (ch === stringChar && source[i - 1] !== '\\') inString = false;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") { inString = true; stringChar = ch; i++; continue; }
      if (ch === '{') { depth++; i++; continue; }
      if (ch === '}') {
        depth--;
        i++;
        if (depth <= 0) break;
        continue;
      }
      i++;
    }
    const block = source.slice(start, i).trim();
    if (block) blocks.push(block);
  }
  return blocks;
}

// ── Categorize a block ──
function categorize(block) {
  const selector = block.slice(0, block.indexOf('{')).trim();

  // Tokens: CSS variables, reset, html, body, color-scheme
  if (/^(:root|\*|html|body|\[data-theme)/.test(selector)) return 'tokens';
  if (/^@keyframes/.test(selector)) {
    if (/skeleton|pulse|spin/i.test(selector)) return 'base';
    if (/viewer|zoom/i.test(selector)) return 'viewer';
    if (/modal|fade/i.test(selector)) return 'modal';
    if (/progress/i.test(selector)) return 'tasks';
    return 'base';
  }
  if (/^@media/.test(selector)) {
    // Categorize media queries by their content
    const inner = block.slice(block.indexOf('{') + 1, block.lastIndexOf('}'));
    if (/\.viewer|\.image-viewer/.test(inner)) return 'viewer';
    if (/\.modal/.test(inner)) return 'modal';
    if (/\.login|\.auth|\.invite/.test(inner)) return 'auth';
    if (/\.prompt|\.composer|\.assistant|\.reference|\.file-field|\.mode-tab/.test(inner)) return 'composer';
    if (/\.task-|\.filter|\.pagination|\.empty-state|\.result-toolbar|\.status-/.test(inner)) return 'tasks';
    if (/\.studio-|\.site-nav|\.mobile|\.sidebar/.test(inner)) return 'layout';
    return 'base';
  }

  // Layout
  if (/\.(studio-|site-nav|mobile|sidebar-open|nav-)/.test(selector)) return 'layout';
  // Auth
  if (/\.(login-|auth-|user-|invite|nav-user)/.test(selector)) return 'auth';
  // Composer
  if (/\.(prompt-|composer-|field|file-|reference-|mode-tab|mode-tabs|quick-prompt|assistant-|custom-select|paste-flash|drop-hint)/.test(selector)) return 'composer';
  // Tasks
  if (/\.(task-|filter-|pagination|empty-state|result-|status-|skeleton|param-item|image-action|img-count|img-load|img-error|no-images)/.test(selector)) return 'tasks';
  // Viewer
  if (/\.(viewer-|image-viewer)/.test(selector)) return 'viewer';
  // Modal
  if (/\.modal/.test(selector)) return 'modal';

  // Base: everything else (buttons, inputs, links, typography, utilities)
  return 'base';
}

// ── Format a CSS block for readability ──
function formatBlock(block) {
  // Add newlines after { and before }
  let result = block
    .replace(/\{/g, ' {\n  ')
    .replace(/;(?![\s}])/g, ';\n  ')
    .replace(/;?\s*\}/g, ';\n}\n')
    .replace(/\{\s*\n\s*\}/g, '{}');

  // Fix trailing semicolons before }
  result = result.replace(/;\n\}\n/g, ';\n}\n');
  // Clean up double newlines
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

// ── Main ──
const blocks = tokenize(css);
console.log(`Parsed ${blocks.length} top-level blocks`);

const modules = {};
for (const block of blocks) {
  const category = categorize(block);
  if (!modules[category]) modules[category] = [];
  modules[category].push(block);
}

const order = ['tokens', 'base', 'layout', 'auth', 'composer', 'tasks', 'viewer', 'modal'];
const written = [];
for (const name of order) {
  const moduleBlocks = modules[name];
  if (!moduleBlocks?.length) continue;
  const formatted = moduleBlocks.map(formatBlock).join('\n\n');
  const outPath = path.join(OUT, `${name}.css`);
  // Don't overwrite tasks.css (already exists with our overrides)
  if (name === 'tasks') {
    // Write as tasks-base.css, the original task styles
    const basePath = path.join(OUT, 'tasks-base.css');
    fs.writeFileSync(basePath, formatted + '\n', 'utf8');
    written.push(`tasks-base.css (${moduleBlocks.length} blocks)`);
  } else {
    fs.writeFileSync(outPath, formatted + '\n', 'utf8');
    written.push(`${name}.css (${moduleBlocks.length} blocks)`);
  }
}

console.log('Written files:');
for (const w of written) console.log(`  ${w}`);
console.log('\nDone! Update client/src/styles/index.css to import the new modules.');
