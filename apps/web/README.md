# MRE Command Center

MRE is XynPrize Ltd.'s authenticated AI command center. It is a
working Next.js application with streaming conversation, microphone capture,
speech playback and interruption, server-side history and memory, agent and
automation controls, scheduling, provider adapters, and an empty
single-workstation local mode.

## Local start

Requirements: Node.js 20.19+, 22.13+, or 24+; npm 10+.

```powershell
Set-Location apps/web
npm install
npm run dev
```

Open `http://localhost:3000`. The server also loads the repository-root `.env`,
so the existing MRE credentials do not need to be duplicated. An app-local
`.env.local` takes precedence. When no database exists, MRE uses an empty
server-persisted local store at `apps/web/.xyn/local-store.json`; it does not use
browser local storage as durable memory and never seeds sample records.

The default development command uses Webpack because Turbopack can stall on
some Windows/Conda combinations. `npm run dev:turbo` remains available where
Turbopack is stable.

For the complete local MRE runtime on port 3001, run the optimized
standalone build:

```powershell
npm run build
npm run start:local
```

Open `http://localhost:3001`. The local launcher copies the standalone assets,
creates a private per-workspace session secret, starts `python -m mrie serve`
when its loopback IPC port is not already listening, and connects the dashboard
to that real runtime. `npm start` uses the same standalone launcher for a fully
configured production environment but does not start local dependencies.

The live presentation routes include `/briefings`, which exposes the durable
evidence-backed briefing archive and manual source/full-run controls, and
`/security`, which exposes read-only Wazuh/honeypot status and normalized events.
Both render explicit empty or unavailable states and never substitute fixtures.

## Speech

Browser microphone capture, live input level, partial Web Speech transcription,
speech synthesis, captions, Stop, and barge-in work without provider keys where
the browser supports them. Unsupported browser recognition falls back to the
server STT route.

For ElevenLabs, choose an original approved MRE voice in your account and set:

```dotenv
STT_PROVIDER=elevenlabs
TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
ELEVENLABS_STT_MODEL=scribe_v2
ELEVENLABS_TTS_MODEL=eleven_flash_v2_5
```

Keys stay server-side. Microphone APIs require HTTPS outside localhost. Do not
configure an actor imitation or a voice intended to copy a protected character.

## PostgreSQL persistence for local development

Compose uses PostgreSQL 17 with pgvector. To run only the database while the
Next.js development server remains on the host, first create a Compose env file
and populate both blank secrets with URL-safe random values:

```powershell
Copy-Item compose.env.example .env.compose
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
# Put separate generated values into POSTGRES_PASSWORD and AUTH_SECRET.
docker compose --env-file .env.compose up -d postgres
Copy-Item .env.example .env.local
# In .env.local set LOCAL_MODE=false, AUTH_SECRET, and the localhost DATABASE_URL.
npm run db:migrate
npm run dev
```

The migration creates users, sessions, conversations, messages, profile/
semantic/episodic memory, preferences, agent runs, automations, schedules,
approvals, and audit events. Every data route filters by authenticated user.

For the first production account, temporarily set `ALLOW_REGISTRATION=true`.
The Create account control is only shown when the server reports that this flag
is enabled, and the registration route enforces the same flag. Register the
first operator, then set it back to `false` and restart the web service.

## Provider routing

```dotenv
# NVIDIA NIM or another OpenAI-compatible endpoint
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://integrate.api.nvidia.com/v1
LLM_MODEL=deepseek-ai/deepseek-v4-flash-0731
LLM_API_KEY=...

# Existing Python MRE process
LLM_PROVIDER=mrie
MRIE_RPC_HOST=127.0.0.1
MRIE_RPC_PORT=17351

# Hermes Agent JSON-RPC/WebSocket gateway
LLM_PROVIDER=hermes
HERMES_GATEWAY_URL=ws://127.0.0.1:9119/api/ws
HERMES_GATEWAY_TOKEN=replace-with-the-same-random-token-used-to-start-hermes
HERMES_APPROVAL_POLICY=manual-required
# Optional: run Hermes against a named profile and/or workspace.
HERMES_GATEWAY_PROFILE=
HERMES_GATEWAY_CWD=
```

The browser only calls the Next.js BFF. The MRE bridge currently adapts its
single-response TCP RPC into web chunks; native MRE event streaming is a later
transport upgrade.

### Hermes Agent bridge

Hermes is an implemented optional language-model/agent provider, not an import
of vendored UI code. MRE speaks the current vendored `tui_gateway` contract:
authenticated JSON-RPC 2.0 over `/api/ws`, `session.create`/`session.resume`,
`prompt.submit`, `message.delta`/`message.complete`, and
`session.interrupt`. The browser never receives the Hermes token or connects to
the Hermes socket directly.

Choose one random token, place it in MRE's server-side `.env.local` as
`HERMES_GATEWAY_TOKEN`, and start Hermes in a separate PowerShell terminal with
the same value:

```powershell
$env:HERMES_DASHBOARD_SESSION_TOKEN = "<same-random-token>"
hermes serve --host 127.0.0.1 --port 9119
```

Then restart MRE with `LLM_PROVIDER=hermes`. `GET /api/status` performs a real
WebSocket handshake and reports `services.hermes` as `connected` or
`unavailable`; repository presence alone is never reported as integration.

The default `HERMES_APPROVAL_POLICY=manual-required` refuses to run when the
Hermes profile has `approvals.mode=smart` or `off`. MRE also explicitly disables
session YOLO and denies gateway `approval.request` events. Secret, sudo, and
interactive clarification requests fail closed because an authenticated,
durable approval/clarification card bridge has not yet been implemented. This
means conversational work and Hermes tools that need no interactive approval
work today; an approval-gated action is deliberately not auto-executed.

The current bridge targets a loopback `hermes serve` token session. OAuth-gated
remote Hermes gateways require single-use ticket minting and are not yet
supported by this adapter. Hermes tools execute on the machine and workspace
where `hermes serve` runs. MRE remains the durable source of conversation and
memory; after a MRE process restart, the adapter safely starts a new Hermes
session seeded from MRE's stored transcript rather than guessing an old runtime
binding.

## Verification

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

### Full Compose stack

The full stack builds two non-root image targets: a one-shot migration service
and the standalone web server. PostgreSQL must be healthy, migrations must exit
successfully, and then the web health check must pass. The web filesystem is
read-only except for temporary Next.js cache paths and the named `.xyn` volume;
that volume makes local runtime persistence writable by UID 1001.

```powershell
Set-Location apps/web
Copy-Item compose.env.example .env.compose
# Generate and set POSTGRES_PASSWORD and AUTH_SECRET as shown above.
docker compose --env-file .env.compose config
docker compose --env-file .env.compose up --build -d
docker compose --env-file .env.compose ps
Invoke-RestMethod http://localhost:3000/api/status
```

Both published ports bind to host loopback by default. Put a TLS reverse proxy
in front of port 3000 for network access, set `NEXT_PUBLIC_APP_URL` to its exact
HTTPS origin, and do not expose PostgreSQL publicly. On an upgrade, run the
migration as a release step before replacing the web service:

```powershell
docker compose --env-file .env.compose build
docker compose --env-file .env.compose run --rm migrate
docker compose --env-file .env.compose up -d web
```

For a platform that builds the image without Compose:

```powershell
docker build -t mrie-command-center .
docker run --rm --read-only --tmpfs /tmp --tmpfs /app/.next/cache `
  --mount type=volume,src=mrie-local,dst=/app/.xyn `
  -p 127.0.0.1:3000:3000 --env-file .env.local mrie-command-center
```

Deploy behind TLS, inject secrets through the platform secret manager, restrict
database network access, and keep MRE RPC on a private server-side network. If
MRE runs as another Compose service, set `MRIE_RPC_HOST` to that service name;
never publish its RPC port to browsers. Back up PostgreSQL and configured object
storage before changes. Never run migrations concurrently from every
application replica.

## Data integrity and current connector boundary

Local mode begins empty and displays only records actually stored through the
application. Production mode uses PostgreSQL and authenticated tenant-scoped
queries. There are no sample objectives, events, agents, conversations,
memories, appointments, or automations in either path.

Automation Run uses a signed token bound to a tenant-scoped, expiring approval
record and an exact automation-configuration hash. Consumption is atomic and
single-use: it marks the approval consumed, queues exactly one run, and appends
an immutable audit event. Repeated preparation is idempotent while the same
approval remains pending, and replay, expiry, cross-tenant use, or configuration
changes fail closed. No external email, calendar, publishing, deletion, lead,
or paid-service connector executes from this queue; each future connector still
needs its own server-side authorization policy.

No XynPrize image logo was found in this repository. The current navigation uses
an original code-native XynPrize wordmark; replace it with the approved logo
asset when supplied.
