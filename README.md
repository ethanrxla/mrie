# MRE

MRE (Modular Research Engine) is XynPrize Ltd.'s operator-owned AI command
center. It combines conversation, scheduled intelligence briefings, voice,
authorized device inspection, and read-only security monitoring.

The Python package is still named `mrie` for compatibility. Legacy
`MRIE_RPC_*`, `.mrie`, and `.xyn` internal names may also remain, but the
product and assistant are MRE.

## Start MRE

Run this once from PowerShell in the repository root:

```powershell
.\mre.ps1 setup
```

After that, this single command starts the backend and dashboard together:

```powershell
.\mre.ps1
```

Open [http://localhost:3001](http://localhost:3001). Keep the PowerShell window
open; press **Ctrl+C** to stop the services launched by that command.

Check whether everything is running with:

```powershell
.\mre.ps1 status
```

With MRE running, test the real RSS/NewsAPI collectors without using an LLM or
voice, or generate and archive a full spoken report:

```powershell
.\mre.ps1 news
.\mre.ps1 briefing
```

The news check reports each RSS feed and the configured NewsAPI status. The
briefing command uses the running scheduler, stores the report, and queues its
ElevenLabs delivery.

The launcher hides the internal Python, Node, standalone-build, authentication,
port, and process-lifecycle commands. It preserves `.env`, private
configuration, conversation history, memories, and briefing archives.

## What the command starts

- MRE's Python capability and tool runtime
- NVIDIA NIM as the primary configured model
- Optional authenticated Codex and Claude subscription delegates
- Briefings at 05:00, 13:00, and 21:00 America/New_York
- The event watcher and read-only Sentinel data plane
- Durable ElevenLabs voice delivery and browser speech controls
- The command dashboard on `127.0.0.1:3001`
- The private backend bridge on `127.0.0.1:17351`

The dashboard contains only real stored data. It does not create demo agents,
objectives, appointments, alerts, or activity.

## Configuration

Private provider credentials belong in the ignored root `.env`. Capability and
access policy belongs in the ignored `config/mrie.yaml`. Setup copies the
example files only when the private files do not already exist.

The current recommended speech configuration is browser microphone input plus
ElevenLabs' premade female Matilda voice:

```dotenv
LLM_PROVIDER=mrie
STT_PROVIDER=browser
TTS_PROVIDER=elevenlabs
ELEVENLABS_VOICE_ID=XrExE9yKIg1WjnnlVkGX
ELEVENLABS_TTS_MODEL=eleven_flash_v2_5
```

Never commit `.env`, API keys, OAuth tokens, CLI login files, or Wazuh
credentials.

## Current integration boundary

NVIDIA NIM, Codex subscription, Claude subscription, RSS, public URL
extraction, and ElevenLabs TTS have been verified. Some connectors still need
real prerequisites and cannot be enabled by a startup command alone:

- NewsAPI currently needs a replacement valid key.
- Brave search needs `BRAVE_SEARCH_API_KEY`.
- A personal YouTube feed needs a real `YOUTUBE_OAUTH_TOKEN`; an API key alone
  is insufficient.
- Reddit reporting is implemented with the official read-only OAuth API, but it
  remains off until Reddit approves the use and the four OAuth values described
  in [the Reddit connection guide](docs/REDDIT.md) are added.
- Instagram's consumer home feed is not exposed by the supported API.
- Wazuh needs a separately secured deployment, TLS CA paths, and
  least-privilege read-only manager/indexer accounts.
- MCP dispatch and the production automation-job executor are not complete.

Hermes is an implemented optional **alternative** dashboard chat route, not a
second simultaneous dashboard model. Its setup is documented in
[the command-center guide](apps/web/README.md). Wazuh setup is documented in
[the Sentinel deployment guide](deploy/wazuh/README.md).

## Optional terminal screens

After setup, these can run in additional PowerShell windows while MRE is up:

```powershell
cargo run --manifest-path tui/Cargo.toml -- --view overview
cargo run --manifest-path tui/Cargo.toml -- --view security
cargo run --manifest-path tui/Cargo.toml -- --view feeds
cargo run --manifest-path tui/Cargo.toml -- --view conversation
cargo run --manifest-path tui/Cargo.toml -- --view voice
```

The complete requirements and trust model are in
[the master specification](docs/MASTER_SPEC.md). Development conventions are
in [CLAUDE.md](CLAUDE.md), speech behavior is in
[the voice runtime guide](docs/VOICE_RUNTIME.md), and deployment details are in
[the command-center guide](apps/web/README.md).

## Commands

```powershell
.\mre.ps1 setup   # once
.\mre.ps1         # start backend + dashboard
.\mre.ps1 status  # check both
.\mre.ps1 news    # test live sources only
.\mre.ps1 briefing # generate + speak a report now
```
