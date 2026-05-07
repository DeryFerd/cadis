# Examples

Runnable examples for C.A.D.I.S. Examples must never contain real credentials.

## Index

| Example | Description |
|---------|-------------|
| [basic-chat.sh](basic-chat.sh) | Basic daemon status check and chat session |
| [workspace-tools.sh](workspace-tools.sh) | Workspace registration and tool usage |
| [config/cadis.example.toml](config/cadis.example.toml) | Annotated configuration template |

## Prerequisites

- `cadisd` and `cadis` installed (see [Installation](../README.md#installation))
- `cadisd` running (`cadisd &`)

## Usage

```bash
# Start the daemon in the background
cadisd &

# Run an example
./basic-chat.sh
./workspace-tools.sh

# Copy the example config
cp config/cadis.example.toml ~/.cadis/config.toml
```
