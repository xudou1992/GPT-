import { Router } from 'express';
import { tasks } from '../storage/index.js';

const router = Router();
const eventClients = new Set();

function sendEvent(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch { return false; }
}

export function broadcastTasksChanged() {
  if (!eventClients.size) return;
  const payload = { now: new Date().toISOString(), tasks: tasks.length };
  for (const client of eventClients) {
    if (!sendEvent(client, 'tasks-updated', payload)) eventClients.delete(client);
  }
}

export function closeAllClients() {
  for (const client of eventClients) {
    sendEvent(client, 'server-closing', { now: new Date().toISOString() });
    client.end?.();
  }
  eventClients.clear();
}

router.get('/', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  sendEvent(res, 'connected', { now: new Date().toISOString(), tasks: tasks.length });

  eventClients.add(res);
  const heartbeat = setInterval(() => {
    if (!sendEvent(res, 'ping', { now: new Date().toISOString() })) {
      clearInterval(heartbeat);
      eventClients.delete(res);
    }
  }, 25000);

  req.on('close', () => { clearInterval(heartbeat); eventClients.delete(res); });
});

export default router;
