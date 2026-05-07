function write(level, module, message, meta = {}) {
  const payload = {
    time: new Date().toISOString(),
    level,
    module,
    message,
    ...normalizeMeta(meta)
  };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const result = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value instanceof Error) {
      result[key] = { name: value.name, message: value.message, stack: value.stack };
    } else {
      result[key] = value;
    }
  }
  return result;
}

export const logger = {
  info: (module, message, meta) => write('info', module, message, meta),
  warn: (module, message, meta) => write('warn', module, message, meta),
  error: (module, message, meta) => write('error', module, message, meta)
};
