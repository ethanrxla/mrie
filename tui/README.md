# MRE Rust TUI

This crate is the multi-terminal display client for MRE. It connects to the
Python core at `127.0.0.1:17351` using newline-delimited JSON-RPC 2.0, polls the
`status` method without blocking terminal input, and sends `ask` requests from
the conversation screen.

## Run

Start the MRE core and its IPC server from the project root, then launch
one or more views:

```powershell
python -m pip install -e .
mrie serve
```

In additional terminals:

```powershell
cd tui
cargo run -- --view overview
cargo run -- --view security
cargo run -- --view feeds
cargo run -- --view conversation
cargo run -- --view voice
```

Each command is an independent client, so the five views can be placed on
separate terminals or displays at the same time. The default endpoint and
five-second refresh can be overridden:

```powershell
cargo run -- --view security --address 127.0.0.1:17351 --refresh-seconds 2
```

Use `R` to refresh non-conversation screens, `Ctrl+R` in conversation, and
`Q`, `Esc`, or `Ctrl+C` to exit. In conversation, type a question and press
`Enter`; `Esc` or `Ctrl+C` exits.

## Protocol

Every request is one UTF-8 JSON object followed by a newline. For example:

```json
{"jsonrpc":"2.0","id":1,"method":"status","params":{}}
```

The TUI opens a short-lived TCP connection per call. This makes each terminal
instance reconnect naturally after a core restart. Network calls run on a
worker thread; the Ratatui event/render loop remains responsive while an LLM
answer is pending.

## Build checks

```powershell
cargo fmt --check
cargo check
```
