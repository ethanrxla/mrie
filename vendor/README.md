# Upstream source policy

## Hermes Agent

`vendor/hermes-agent` is a clean upstream checkout of
<https://github.com/NousResearch/hermes-agent> pinned during foundation work to:

```text
33f8e96a72945afb29f3bc9ef9991940f0bedcf7
```

Hermes Agent is MIT-licensed. Preserve its `LICENSE` and upstream attribution.
MRIE will first integrate through a stable service/plugin/app-server boundary.
Do not edit or import private credential/OAuth internals to make subscription
authentication work; the official runtimes own their credentials.

Before updating the pin, record the new revision, review licenses/security/API
changes, run the upstream adapter tests, and update the master specification.

## Warp

Warp is not vendored. The current <https://github.com/warpdotdev/warp> client is
mixed-license: specifically identified UI crates are MIT while the remaining
client is AGPL-3.0. The default integration is to run MRIE inside Warp as an
external terminal/profile. Any source reuse needs an exact-crate/revision license
review and a recorded decision; do not copy the repository wholesale.
