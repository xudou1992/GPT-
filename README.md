# Image API Studio

Image API Studio is a lightweight web studio for OpenAI-compatible image generation APIs. It provides a protected frontend, task queue, generated image storage, manual API endpoint switching, and an admin dashboard.

## Features

- Text-to-image and image-to-image workflows
- Reference image upload by click, drag and drop, or paste
- Manual API base URL and API key switching from the admin UI
- Single locked image model by default: `gpt-image-2`
- Task queue with retry, cancel, delete, filters, progress, and SSE updates
- Generated image storage with thumbnail endpoint and image viewer
- Prompt assistant endpoint for compatible chat completion providers
- Admin dashboard for service status, storage stats, API settings, and cleanup
- Vite frontend build with hashed static assets

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

Edit `.env` and set your own API credentials before generating images.

The app runs on `http://localhost:3000` by default.

## Configuration

Copy `.env.example` to `.env`:

```ini
OPENAI_API_KEY=
OPENAI_BASE_URL=https://your-provider.example/v1
IMAGE_MODEL=gpt-image-2

PORT=3000
ACCESS_PASSWORD=
IMAGE_API_TIMEOUT_MS=900000
IMAGE_API_RETRIES=3
IMAGE_API_RETRY_DELAY_MS=2000
MAX_TASK_IMAGES=50
MAX_TASK_CONCURRENCY=10
IMAGE_API_GLOBAL_CONCURRENCY=10
MAX_PROMPT_LENGTH=4000
MAX_REFERENCE_IMAGES=10
MAX_REFERENCE_IMAGE_BYTES=0
MAX_REFERENCE_TOTAL_BYTES=0
MAX_IMAGE_EDGE=4096
MAX_IMAGE_PIXELS=16777216
```

`MAX_REFERENCE_IMAGE_BYTES=0` and `MAX_REFERENCE_TOTAL_BYTES=0` disable upload size limits. Use positive byte values if you want limits.

## Development

```bash
npm run dev
npm test
npm run build:client
npm run check
```

## Deployment

The included deploy script uploads the built app to a server over SSH/SFTP.

```bash
cp .env.deploy.example .env.deploy
# edit DEPLOY_HOST, DEPLOY_USER, and either DEPLOY_SSH_PASSWORD or DEPLOY_SSH_KEY
node deploy.js
```

The script:

- Builds the frontend
- Uploads frontend and backend files
- Installs production dependencies on the server
- Restarts `image-api-studio.service`

Do not commit `.env` or `.env.deploy`. They are ignored by git.

## API Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Health check |
| GET | `/api/config` | Frontend config |
| POST | `/api/login` | Login |
| POST | `/api/register` | Register with invite code |
| POST | `/api/logout` | Logout |
| GET | `/api/tasks` | List tasks |
| POST | `/api/tasks` | Create generation task |
| POST | `/api/tasks/:id/cancel` | Cancel task |
| POST | `/api/tasks/:id/retry` | Retry task |
| DELETE | `/api/tasks/:id` | Delete task |
| GET | `/api/events` | SSE task updates |
| POST | `/api/prompt-assistant` | Prompt assistant |
| GET | `/api/admin/dashboard` | Admin dashboard |
| GET | `/api/admin/storage` | Storage stats |
| POST | `/api/admin/tasks/cleanup` | Cleanup old tasks |

## Security Notes

- Never commit `.env`, `.env.deploy`, generated images, or runtime data.
- Rotate any credential that was ever pasted into logs, chat, screenshots, or committed history.
- Put this app behind HTTPS before exposing it publicly.

## License

MIT
