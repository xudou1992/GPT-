# Image API Studio

Image API Studio 是一个轻量级的 Web 图片工作台，适用于兼容 OpenAI 接口规范的生图 API。它提供受保护的前端界面、任务队列、生成图片存储、手动切换 API 节点，以及管理员面板。

## 功能特性

- 文生图与图生图工作流
- 支持点击、拖拽、粘贴上传参考图
- 可在管理后台手动切换 API Base URL 和 API Key
- 默认锁定单一图片模型：`gpt-image-2`
- 任务队列支持重试、取消、删除、筛选、进度展示和 SSE 实时更新
- 生成图片支持本地存储、缩略图接口和图片查看器
- 为兼容的聊天补全服务提供提示词助手接口
- 管理员面板支持服务状态、存储统计、API 设置和清理操作
- 前端基于 Vite 构建，静态资源带哈希输出

## 快速开始

```bash
npm install
cp .env.example .env
npm run dev
```

开始生图前，请先编辑 `.env`，填入你自己的 API 配置。

默认访问地址为 `http://localhost:3000`。

## 配置说明

将 `.env.example` 复制为 `.env`：

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

`MAX_REFERENCE_IMAGE_BYTES=0` 和 `MAX_REFERENCE_TOTAL_BYTES=0` 表示关闭上传体积限制。如果你希望限制大小，请填写大于 0 的字节数。

## 开发命令

```bash
npm run dev
npm test
npm run build:client
npm run check
```

## 部署说明

项目内置了部署脚本，可通过 SSH/SFTP 将构建后的应用上传到服务器。

```bash
cp .env.deploy.example .env.deploy
# 修改 DEPLOY_HOST、DEPLOY_USER，以及 DEPLOY_SSH_PASSWORD 或 DEPLOY_SSH_KEY
node deploy.js
```

部署脚本会执行以下操作：

- 构建前端
- 上传前端和后端文件
- 在服务器安装生产依赖
- 重启 `image-api-studio.service`

不要提交 `.env` 或 `.env.deploy`，它们已经被 Git 忽略。

## API 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/config` | 前端配置 |
| POST | `/api/login` | 登录 |
| POST | `/api/register` | 使用邀请码注册 |
| POST | `/api/logout` | 退出登录 |
| GET | `/api/tasks` | 获取任务列表 |
| POST | `/api/tasks` | 创建生图任务 |
| POST | `/api/tasks/:id/cancel` | 取消任务 |
| POST | `/api/tasks/:id/retry` | 重试任务 |
| DELETE | `/api/tasks/:id` | 删除任务 |
| GET | `/api/events` | SSE 任务更新流 |
| POST | `/api/prompt-assistant` | 提示词助手 |
| GET | `/api/admin/dashboard` | 管理员面板数据 |
| GET | `/api/admin/storage` | 存储统计 |
| POST | `/api/admin/tasks/cleanup` | 清理旧任务 |

## 安全说明

- 不要提交 `.env`、`.env.deploy`、生成图片或运行时数据。
- 任何曾经出现在日志、聊天记录、截图或提交历史中的密钥，都应该立即轮换。
- 如果要对外公开访问，请务必先通过 HTTPS 反向代理或网关暴露服务。

## 开源协议

MIT
