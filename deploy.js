import SftpClient from 'ssh2-sftp-client';
import { Client } from 'ssh2';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.deploy' });
dotenv.config();

const config = {
  host: process.env.DEPLOY_HOST,
  port: Number(process.env.DEPLOY_PORT || 22),
  username: process.env.DEPLOY_USER,
  password: process.env.DEPLOY_SSH_PASSWORD || undefined,
  privateKey: process.env.DEPLOY_SSH_KEY ? readFileSync(process.env.DEPLOY_SSH_KEY) : undefined,
  readyTimeout: 30000,
  keepaliveInterval: 10000,
  keepaliveCountMax: 3
};

const REMOTE = '/opt/image-api-studio';

if (!config.host || !config.username) {
  throw new Error('Missing deploy target. Set DEPLOY_HOST and DEPLOY_USER in .env.deploy.');
}

if (!config.password && !config.privateKey) {
  throw new Error('Missing deploy credentials. Set DEPLOY_SSH_PASSWORD or DEPLOY_SSH_KEY in .env.deploy.');
}

function getUploadFiles() {
  const html = readFileSync('public/index.html', 'utf8');
  const assetFiles = [...new Set([...html.matchAll(/\/assets\/[^"']+/g)].map(match => match[0]))]
    .map(assetPath => [`public${assetPath}`, `${REMOTE}/public${assetPath}`]);
  return [
    // Frontend (HTML entry + hashed assets)
    ['public/index.html', `${REMOTE}/public/index.html`],
    ...assetFiles,
    // Backend - src/
    ['src/index.js', `${REMOTE}/src/index.js`],
    ['src/config.js', `${REMOTE}/src/config.js`],
    ['src/logger.js', `${REMOTE}/src/logger.js`],
    ['src/utils.js', `${REMOTE}/src/utils.js`],
    ['src/middleware/auth.js', `${REMOTE}/src/middleware/auth.js`],
    ['src/middleware/security.js', `${REMOTE}/src/middleware/security.js`],
    ['src/storage/index.js', `${REMOTE}/src/storage/index.js`],
    ['src/services/image-api.js', `${REMOTE}/src/services/image-api.js`],
    ['src/services/prompt-assistant.js', `${REMOTE}/src/services/prompt-assistant.js`],
    ['src/routes/health.js', `${REMOTE}/src/routes/health.js`],
    ['src/routes/auth.js', `${REMOTE}/src/routes/auth.js`],
    ['src/routes/tasks.js', `${REMOTE}/src/routes/tasks.js`],
    ['src/routes/sse.js', `${REMOTE}/src/routes/sse.js`],
    ['src/routes/api.js', `${REMOTE}/src/routes/api.js`],
    ['src/routes/admin.js', `${REMOTE}/src/routes/admin.js`],
    ['src/routes/api-settings.js', `${REMOTE}/src/routes/api-settings.js`],
    // Legacy (kept for rollback)
    ['server.js', `${REMOTE}/server.js`],
    // Package
    ['package.json', `${REMOTE}/package.json`],
    ...(existsSync('package-lock.json') ? [['package-lock.json', `${REMOTE}/package-lock.json`]] : []),
  ];
}

function cleanLocalAssets() {
  rmSync('public/assets', { recursive: true, force: true });
  mkdirSync('public/assets', { recursive: true });
}

const remoteDirs = [
  `${REMOTE}/public/assets`,
  `${REMOTE}/src`,
  `${REMOTE}/src/middleware`,
  `${REMOTE}/src/storage`,
  `${REMOTE}/src/services`,
  `${REMOTE}/src/routes`,
];

async function deploy() {
  console.log('Cleaning local hashed assets...');
  cleanLocalAssets();

  console.log('Building frontend with Vite...');
  execSync('npx vite build --config client/vite.config.js --configLoader native', { stdio: 'inherit' });

  const uploadFiles = getUploadFiles();
  console.log(`Found ${uploadFiles.length} files to upload.`);

  const sftp = new SftpClient();
  try {
    console.log('Connecting to SFTP...');
    await sftp.connect(config);

    // Ensure remote directories exist
    for (const dir of remoteDirs) {
      try { await sftp.mkdir(dir, true); } catch {}
    }

    // Clean old hashed assets on remote
    try {
      const oldAssets = await sftp.list(`${REMOTE}/public/assets`);
      for (const f of oldAssets) {
        if (f.type !== '-') continue;
        await sftp.delete(`${REMOTE}/public/assets/${f.name}`);
      }
    } catch {}

    // Upload all files
    for (const [local, remote] of uploadFiles) {
      console.log(`Uploading ${local}...`);
      await sftp.put(local, remote);
    }

    console.log('Upload complete. Disconnecting SFTP...');
    await sftp.end();

    console.log('Connecting via SSH to install deps & restart...');
    const conn = new Client();
    conn.on('ready', () => {
      console.log('SSH connection ready.');
      const cmd = [
        `cd ${REMOTE} && npm install --omit=dev 2>&1`,
        // Update systemd service to use new entry point
        `sed -i 's|ExecStart=.*|ExecStart=/usr/bin/node ${REMOTE}/src/index.js|' /etc/systemd/system/image-api-studio.service`,
        `systemctl daemon-reload`,
        `systemctl restart image-api-studio`,
        `sleep 2`,
        `systemctl status image-api-studio --no-pager 2>&1`
      ].join('; ');
      conn.exec(cmd, (err, stream) => {
        if (err) throw err;
        stream.on('close', (code, signal) => {
          console.log('Service restarted.');
          conn.end();
        }).on('data', (data) => {
          console.log('STDOUT: ' + data);
        }).stderr.on('data', (data) => {
          console.log('STDERR: ' + data);
        });
      });
    }).connect(config);

  } catch (err) {
    console.error(err.message);
  }
}

deploy();
