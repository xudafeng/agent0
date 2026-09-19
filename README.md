# agent0

A desktop AI agent with conversations, live tool activity, task planning, MCP integration, and persistent memory.

![agent0 desktop app showing the conversation view and agent workspace](docs/images/agent0-desktop.png)

## Desktop app

```bash
pnpm install
pnpm start
```

The app opens a native desktop window. Choose **Model settings**, select Kimi or OpenAI, and enter your model ID and API key. Ask a question or describe a task to begin.

- Press Enter to send, or Shift + Enter for a new line.
- Watch tool activity and the agent's task plan in the workspace panel.
- Save useful context in Memory to reuse across conversations.
- Choose New conversation (Cmd/Ctrl + N) to clear the chat and plan while keeping memory.

Model responses appear when each agent run finishes; tool activity updates during the run. The current conversation survives a window reload and stays in memory until you start a new conversation or quit. Saved memory and model settings persist after quitting.

## Build a macOS app

```bash
pnpm package
```

Open `release/mac-arm64/agent0.app` on Apple Silicon (or `release/mac/agent0.app` on Intel). You can copy the app into Applications. This local build is unsigned and is not notarized for distribution.

The packaged app stores settings in `~/Library/Application Support/agent0/.env`, with memory and traces in its `data` directory. Development uses the project's `.env` and `data` directory. API keys are stored locally in plaintext and are never bundled into the app. Requests go to the configured model provider.

## Command line

```bash
cp .env.example .env
# Fill in your provider settings.
pnpm cli
```

| Command | Description |
| --- | --- |
| `/memory` | Show persistent memory. |
| `/remember <text>` | Save a memory. |
| `/task` | Show the current task plan. |
| `exit` | Quit. |

See [configuration](docs/configuration.md) for provider settings.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:desktop
pnpm eval
```

The desktop smoke test uses an isolated temporary profile and a local mock model endpoint; it does not use your API keys. Evaluation calls your configured real model.
