# MRE voice runtime

MRE has two separate speech-delivery paths:

1. The authenticated web dashboard requests speech from its server-side TTS
   adapter and plays the returned audio in the browser. Browser mute, Stop, and
   barge-in remain presentation-layer controls.
2. The Python daemon renders scheduled or explicit unattended speech, records
   every delivery transition, and can hand the resulting audio file to an
   allowlisted local playback adapter.

The two paths share the configured ElevenLabs identity but do not share API
keys with browser code. The default server-side voice is the premade female
voice Matilda (`XrExE9yKIg1WjnnlVkGX`) with `eleven_flash_v2_5`.

## Unattended playback requirements

Set `ELEVENLABS_API_KEY` in the repository-root `.env`. The `auto` playback
setting prefers `ffplay` (normally distributed with FFmpeg). On Windows it can
fall back to the .NET desktop media runtime through Windows PowerShell. An
explicit ffplay installation can be selected with
`voice.playback.ffplay_path` in the operator-owned `config/mrie.yaml`. The
daemon must run in an interactive OS session with access to a working audio
output device.

Set `MRE_SPEECH_STORAGE_DIR` to a dedicated server-side directory on a volume
with sufficient space (for example, `D:\mrie-speech-runtime` on Windows). An
operator can instead set `voice.storage_dir` in `config/mrie.yaml`; the
environment value takes precedence, and relative paths resolve from the
repository root. Filesystem roots, the user home directory, and the repository
root are rejected so retention can never treat a broad directory as disposable.
The default remains `logs/speech/` for compatibility when neither setting is
present.

MRE does not accept an arbitrary playback shell command. The ffplay adapter
invokes only ffplay with a fixed argument shape and a bounded timeout. On
Windows, MRE invokes a fixed non-interactive PowerShell script; the
audio path is passed as data through the child-process environment and is never
interpolated into the script. The child receives only a small allowlist of
Windows runtime variables plus the audio path and timeout; model, voice, social,
and security credentials are not forwarded. If neither backend is available,
synthesis can still succeed: the MP3 is retained in the configured speech
storage directory, a `queued` transition is recorded, and `played` remains
false.

The example uses a 15-minute playback ceiling so a concise spoken briefing can
finish while a stalled backend remains bounded. Shorter deployments can lower
`voice.playback.timeout_seconds`.

An explicit `ffplay_path` must be an absolute existing path whose filename is
`ffplay` or `ffplay.exe`; other executable names are rejected.

`played` has a deliberately narrow meaning: the configured local player
accepted the file and exited successfully after playback. It cannot prove that
speakers were powered on or that a human heard the message. Human
acknowledgement and automatic draining/retry of queued audio are not yet
implemented for audio retained by quiet hours or an unavailable local player.
Scheduled briefing requests use the separate durable worker described below.

## Delivery states

The daemon appends JSON Lines records under `logs/speech/`:

- `planned`: MRE accepted the speech request before synthesis.
- `rendered`: the provider returned audio and MRE stored its SHA-256 digest.
- `render_failed`: no usable audio was produced.
- `queued`: audio is retained but has not been confirmed as played, including
  quiet-hours suppression and unavailable local playback.
- `played`: the local playback adapter completed successfully.
- `play_failed`: synthesis succeeded but the local player failed or timed out.
- `retention_pruned`: a generated audio artifact was removed after delivery or
  while queued to enforce the configured age, file-count, or byte ceiling. The
  record includes the prior delivery state and exact policy reason.

Audio retention is always bounded. Defaults are 64 generated files, 128 MiB in
aggregate, and 14 days. MRE only recognizes its immediate
`utterance-<time>-<id>.<extension>` children as owned artifacts; it neither
recurses nor removes other files. Played/failed artifacts are selected before
queued artifacts when a count or byte ceiling requires space. Queued audio is
not an indefinite delivery guarantee: it can eventually be pruned, and the
append-only JSONL audit remains under `logs/speech/` to preserve that truth.
The audio currently being rendered or handed to the local player is protected
from pruning until delivery returns. If protected files leave insufficient
capacity, the new render fails explicitly instead of exceeding the ceiling.

`voice.status` reports provider configuration, playback availability, current
quiet-hours state, counts based on the latest state of each utterance, and
non-sensitive storage totals/policy. It does not expose the configured server
path and never reports a queued or merely rendered file as played.

## Scheduled briefing delivery

Briefing generation, archival, and cron-slot completion do not wait for a long
speech render or playback. The archive and a delivery job are written in one
SQLite transaction; the API returns `queued`, and one daemon worker drains jobs
oldest first. Public briefing records retain only delivery state, utterance ID,
and a sanitized reason. Audio paths, hashes, and provider payloads remain in the
private speech audit and are never copied into the dashboard archive.

On daemon startup, an older unclaimed `pending` briefing is safely recovered to
the queue. If a crash interrupted a job after it was claimed, MRE marks it
`delivery_failed` with `delivery_interrupted_unknown` and does not replay it:
the system cannot know whether playback occurred before the crash. Stopping the
daemon during delivery follows the same conservative rule. This favors avoiding
surprise duplicate speech over automatic at-least-once playback.

Running a one-shot `python -m mrie briefing` command does not start the daemon
worker, so the archived report truthfully records voice as unavailable. Use
`python -m mrie serve` for scheduled/background delivery; the web dashboard's
user-initiated Play control remains independent.

## Quiet hours

The example configuration queues routine unattended speech from 22:00 through
07:00 America/New_York. Intervals may cross midnight. An interval with identical
start and end times means quiet hours are active all day.

An explicit operator/manual/verification trigger may bypass quiet hours when
`operator_override` is enabled. Only `critical` severity bypasses quiet hours
through `critical_override`; text generated by a model cannot change this
deterministic policy. Quiet-hours decisions affect daemon-host playback only,
not a user-initiated Play action in the web dashboard.

## Current limitations

- Audio is rendered as a complete file before playback; server-side streaming
  playback is still planned.
- Queued audio is durable and visible in the audit log, but there is no automatic
  acknowledgement endpoint. Briefing delivery jobs are drained automatically;
  quiet-hours audio rendered by the voice capability remains retained without a
  later quiet-hours retry worker.
- The ffplay process exit code verifies backend completion, not physical
  audibility or listener acknowledgement.
- On Windows, success requires the media clock to make observable progress and
  reach the file's reported natural duration for three consecutive samples.
  Startup, timeout, stalled playback, and backend errors are failures. This is a
  pragmatic desktop fallback rather than the final streaming backend.
- Always-listening microphone input and local Whisper transcription remain
  separate unfinished work.
- ElevenLabs plan, attribution, and commercial-use terms must be reviewed for
  the deployment account.

The Windows completion inputs are documented by Microsoft in the
[MediaPlayer class](https://learn.microsoft.com/en-us/dotnet/api/system.windows.media.mediaplayer?view=windowsdesktop-10.0),
[Position](https://learn.microsoft.com/en-us/dotnet/api/system.windows.media.mediaplayer.position?view=windowsdesktop-10.0),
and [NaturalDuration](https://learn.microsoft.com/en-us/dotnet/api/system.windows.media.mediaplayer.naturalduration?view=windowsdesktop-10.0).
