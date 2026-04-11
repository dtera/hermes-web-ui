# Hermes Web UI

Web dashboard for [Hermes Agent](https://github.com/EKKOLearnAI/hermes-agent) — chat interaction and scheduled job management.

## Tech Stack

- **Vue 3** — Composition API + `<script setup>`
- **TypeScript**
- **Vite** — Build tool
- **Naive UI** — Component library
- **Pinia** — State management
- **Vue Router** — Routing (Hash mode)
- **SCSS** — Style preprocessor
- **markdown-it** + **highlight.js** — Markdown rendering and code highlighting

## Getting Started

### 1. Configure API Server

Edit `~/.hermes/config.yaml` and enable the API Server:

```yaml
platforms:
  api_server:
    enabled: true
    host: "127.0.0.1"
    port: 8642
    key: ""
    cors_origins: "*"
```

Restart the Gateway to apply changes:

```bash
hermes gateway restart
```

### 2. Install and Run

```bash
# Global install
npm install -g hermes-web-ui

# Start the web dashboard (default http://localhost:8648)
hermes-web-ui start
```

### Development Mode

```bash
git clone https://github.com/EKKOLearnAI/hermes-web-ui.git
cd hermes-web-ui
npm install
npm run dev
```

## Project Structure

```
src/
├── api/
│   ├── client.ts              # HTTP client (fetch + Bearer Auth)
│   ├── chat.ts                # Chat API (startRun + SSE event stream)
│   ├── jobs.ts                # Scheduled job CRUD
│   └── system.ts              # Health check, model list
├── stores/
│   ├── app.ts                 # Global state (connection, version, models)
│   ├── chat.ts                # Chat state (messages, sessions, streaming)
│   └── jobs.ts                # Job state (list, CRUD operations)
├── components/
│   ├── layout/
│   │   └── AppSidebar.vue     # Sidebar navigation
│   ├── chat/
│   │   ├── ChatPanel.vue      # Chat panel (session list + chat area)
│   │   ├── MessageList.vue    # Message list (auto-scroll, loading animation)
│   │   ├── MessageItem.vue    # Single message (user/AI/tool/system)
│   │   ├── ChatInput.vue      # Input box (Enter to send, Shift+Enter for newline)
│   │   └── MarkdownRenderer.vue # Markdown renderer (code highlighting, copy)
│   └── jobs/
│       ├── JobsPanel.vue      # Job panel
│       ├── JobCard.vue        # Job card
│       └── JobFormModal.vue   # Create/edit job modal
├── views/
│   ├── ChatView.vue           # Chat page
│   └── JobsView.vue           # Jobs page
├── router/
│   └── index.ts               # Router configuration
├── styles/
│   ├── variables.scss         # SCSS design tokens
│   ├── global.scss            # Global styles
│   └── theme.ts               # Naive UI theme overrides
├── composables/
│   └── useKeyboard.ts         # Keyboard shortcuts
└── main.ts                    # App entry point
```

## Features

### Chat

- Async Run + SSE event stream via `/v1/runs` + `/v1/runs/{id}/events`
- Real-time streaming output with tool call progress visualization
- Multi-session management with localStorage persistence
- Markdown rendering with syntax highlighting and one-click code copy

### Scheduled Jobs

- Job list view (including paused/disabled jobs)
- Create, edit, and delete jobs
- Pause and resume jobs
- Trigger immediate job execution
- Cron expression quick presets

### Other

- Real-time connection status monitoring (30s polling)
- Minimalist black-and-white theme
- Keyboard shortcuts (Ctrl+N for new chat, Ctrl+J for jobs)

---

## API Reference

Base URL: `http://127.0.0.1:8642`

### Authentication

All endpoints except `/health` support Bearer Token authentication (if `key` is configured on the server):

```
Authorization: Bearer <your-api-key>
```

When no key is configured, all requests are allowed without authentication.

### Error Format

```json
{
  "error": {
    "message": "Error description",
    "type": "invalid_request_error",
    "param": null,
    "code": "invalid_api_key"
  }
}
```

| Status Code | Description |
|-------------|-------------|
| 200 | Success |
| 400 | Bad request |
| 401 | Invalid API key |
| 404 | Not found |
| 413 | Request body too large (max 1MB) |
| 429 | Concurrent run limit exceeded (max 10 runs) |
| 500 | Internal server error |

---

### 1. Health Check

**GET** `/health` or `/v1/health`

No authentication required.

```json
{"status": "ok", "platform": "hermes-agent"}
```

---

### 2. Model List

**GET** `/v1/models`

```json
{
  "object": "list",
  "data": [
    {
      "id": "hermes-agent",
      "object": "model",
      "created": 1744348800,
      "owned_by": "hermes"
    }
  ]
}
```

---

### 3. Chat Completions (OpenAI Compatible)

**POST** `/v1/chat/completions`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| messages | array | Y | Message array, same format as OpenAI |
| stream | boolean | N | Enable streaming, default false |
| model | string | N | Model name, default "hermes-agent" |

Optional header: `X-Hermes-Session-Id` to specify a session ID.

**stream=false response:**
```json
{
  "id": "chatcmpl-xxxxx",
  "object": "chat.completion",
  "created": 1744348800,
  "model": "hermes-agent",
  "choices": [{"index": 0, "message": {"role": "assistant", "content": "Response content"}, "finish_reason": "stop"}],
  "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}
}
```

**stream=true response:** SSE stream (`Content-Type: text/event-stream`)
```
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"Hello"},"index":0}]}
data: [DONE]
```

---

### 4. Responses (Stateful Chained Conversations)

**POST** `/v1/responses`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| input | string / array | Y | User input |
| instructions | string | N | System instructions |
| previous_response_id | string | N | Previous response ID for chained conversation |
| conversation | string | N | Conversation name, auto-chains to latest response |
| conversation_history | array | N | Explicit conversation history |
| store | boolean | N | Whether to store the response, default true |
| truncation | string | N | Set to "auto" to truncate history to 100 messages |
| model | string | N | Model name |

> `conversation` and `previous_response_id` are mutually exclusive.

Optional header: `Idempotency-Key` for idempotency.

```json
{
  "id": "resp_xxx",
  "object": "response",
  "status": "completed",
  "created_at": 1744348800,
  "output": [{"type": "message", "role": "assistant", "content": "Response content"}],
  "usage": {"input_tokens": 100, "output_tokens": 50, "total_tokens": 150}
}
```

---

### 5. Get / Delete Stored Responses

**GET** `/v1/responses/{response_id}` — Get a stored response

**DELETE** `/v1/responses/{response_id}` — Delete a stored response

```json
{"id": "resp_xxx", "object": "response", "deleted": true}
```

---

### 6. Start Async Run

**POST** `/v1/runs`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| input | string / array | Y | User input |
| instructions | string | N | System instructions |
| previous_response_id | string | N | Chained conversation ID |
| conversation_history | array | N | Conversation history |
| session_id | string | N | Session ID, defaults to run_id |

```json
{"run_id": "run_xxx", "status": "started"}
```

---

### 7. SSE Event Stream

**GET** `/v1/runs/{run_id}/events`

`Content-Type: text/event-stream`

**Event types:**

| Event | Description |
|-------|-------------|
| `run.started` | Run started |
| `message.delta` | Message content fragment (field `delta`) |
| `tool.started` | Tool call started (fields `tool`, `preview`) |
| `tool.completed` | Tool call completed (fields `tool`, `duration`) |
| `run.completed` | Run completed (fields `output`, `usage`) |
| `run.failed` | Run failed (field `error`) |

Example:
```
data: {"event":"message.delta","run_id":"run_xxx","delta":"Hello","timestamp":...}
data: {"event":"tool.started","run_id":"run_xxx","tool":"browser_navigate","preview":"https://...","timestamp":...}
data: {"event":"tool.completed","run_id":"run_xxx","tool":"browser_navigate","duration":3.8,"timestamp":...}
data: {"event":"run.completed","run_id":"run_xxx","output":"Full response","usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150}}
```

---

### 8. Scheduled Jobs

#### List Jobs

**GET** `/api/jobs?include_disabled=true`

```json
{
  "jobs": [
    {
      "job_id": "61a5eb0baeb9",
      "name": "Job name",
      "schedule": "0 9 * * *",
      "repeat": "forever",
      "deliver": "origin",
      "next_run_at": "2026-04-12T09:00:00+08:00",
      "last_run_at": "2026-04-11T09:04:25+08:00",
      "last_status": "ok",
      "enabled": true,
      "state": "scheduled",
      "prompt_preview": "...",
      "skills": []
    }
  ]
}
```

#### Create Job

**POST** `/api/jobs`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Y | Job name (max 200 characters) |
| schedule | string | Y | Cron expression |
| prompt | string | N | Job prompt |
| deliver | string | N | Delivery target (origin / local / telegram / discord) |
| skills | array | N | Skill name array |
| repeat | integer | N | Repeat count, omit for indefinite |

Response is wrapped in `{"job": {...}}`.

#### Get Job Detail

**GET** `/api/jobs/{job_id}`

#### Update Job

**PATCH** `/api/jobs/{job_id}`

Updatable fields: `name`, `schedule`, `prompt`, `deliver`, `skills`, `repeat`, `enabled`

#### Delete Job

**DELETE** `/api/jobs/{job_id}`

```json
{"ok": true}
```

#### Pause Job

**POST** `/api/jobs/{job_id}/pause`

```json
{"job": {"job_id": "xxx", "enabled": false, "state": "paused", ...}}
```

#### Resume Job

**POST** `/api/jobs/{job_id}/resume`

```json
{"job": {"job_id": "xxx", "enabled": true, "state": "scheduled", ...}}
```

#### Trigger Job Now

**POST** `/api/jobs/{job_id}/run`

```json
{"job": {"job_id": "xxx", "state": "scheduled", ...}}
```

---

## Quick Test

```bash
# Health check
curl http://127.0.0.1:8642/health

# Model list
curl http://127.0.0.1:8642/v1/models

# Chat Completions
curl -X POST http://127.0.0.1:8642/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'

# Start async Run
curl -X POST http://127.0.0.1:8642/v1/runs \
  -H "Content-Type: application/json" \
  -d '{"input":"Hello"}'

# Listen to Run event stream
curl http://127.0.0.1:8642/v1/runs/{run_id}/events

# List jobs (including disabled)
curl "http://127.0.0.1:8642/api/jobs?include_disabled=true"

# Create job
curl -X POST http://127.0.0.1:8642/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Job","schedule":"0 9 * * *","prompt":"Run test"}'

# Pause / Resume / Trigger / Delete
curl -X POST http://127.0.0.1:8642/api/jobs/{job_id}/pause
curl -X POST http://127.0.0.1:8642/api/jobs/{job_id}/resume
curl -X POST http://127.0.0.1:8642/api/jobs/{job_id}/run
curl -X DELETE http://127.0.0.1:8642/api/jobs/{job_id}
```

## License

[MIT](./LICENSE)
