import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Client } from 'ssh2';

// Load deploy env
const deployEnv = {};
for (const line of readFileSync('.env.deploy', 'utf8').split('\n')) {
  const m = line.match(/^(\w+)=(.*)$/);
  if (m) deployEnv[m[1]] = m[2];
}

const host = deployEnv.DEPLOY_HOST;
const port = Number(deployEnv.DEPLOY_PORT) || 22;
const username = deployEnv.DEPLOY_USER;
const password = deployEnv.DEPLOY_SSH_PASSWORD;

if (!host || !username || !password) {
  throw new Error('Set DEPLOY_HOST, DEPLOY_USER, and DEPLOY_SSH_PASSWORD in .env.deploy before restarting remotely.');
}

console.log(`Connecting to ${username}@${host}:${port}...`);

const conn = new Client();
const timeout = setTimeout(() => { console.log('TIMEOUT after 30s'); process.exit(1); }, 30000);

conn.on('ready', () => {
  console.log('SSH connected!');
  const cmd = [
    'cd /opt/image-api-studio',
    'npm install --omit=dev 2>&1',
    'systemctl restart image-api-studio',
    'sleep 3',
    'systemctl status image-api-studio --no-pager',
    'echo "---RECENT LOGS---"',
    'journalctl -u image-api-studio --no-pager -n 40'
  ].join(' && ');

  conn.exec(cmd, (err, stream) => {
    if (err) { console.error('Exec error:', err); conn.end(); return; }
    stream.on('data', (data) => process.stdout.write(data));
    stream.stderr.on('data', (data) => process.stderr.write(data));
    stream.on('close', () => { clearTimeout(timeout); conn.end(); });
  });
}).on('error', (err) => {
  console.error('SSH error:', err.message);
  clearTimeout(timeout);
  process.exit(1);
}).connect({ host, port, username, password, readyTimeout: 25000 });
