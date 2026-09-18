# agent0

An AI agent runtime with tool calling, MCP integration, persistent memory, and task planning.

## Run

```bash
pnpm install
cp .env.example .env
# Fill in MOONSHOT_API_KEY in .env (the example selects Kimi).
pnpm start
```

See [configuration](docs/configuration.md) for provider settings.

## Commands

Enter a message to start a run, or use these commands:

| Command | Description |
| --- | --- |
| `/memory` | Show persistent memory. |
| `/remember <text>` | Save a memory. |
| `/task` | Show the current task plan. |
| `exit` | Quit. |

## Development

```bash
pnpm typecheck
pnpm test
pnpm eval
```
