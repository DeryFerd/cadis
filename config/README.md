# Config

Example CADIS configuration files live here.

Runtime user configuration defaults to:

```text
~/.cadis/config.toml
```

Do not commit real provider keys, Telegram tokens, or local private paths.

Voice config is daemon-owned. Supported visible TTS provider IDs are `edge`,
`elevenlabs`, `openai`, and `system`; `stub` is reserved for deterministic
tests. `voice_id` is provider-specific and can be replaced locally. Provider
keys must stay in local environment or secret files and must not be committed.

The desktop MVP example is:

- [cadis.example.toml](cadis.example.toml)
