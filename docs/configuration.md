# Configuration

agent0 reads model provider settings from `.env` in the project directory. Values in this file override environment variables with the same names.

```bash
cp .env.example .env
```

Set `LLM_PROVIDER` to `openai` or `kimi` and configure the corresponding variables below. If a required value is missing, the application reports its variable name.

## OpenAI

```dotenv
LLM_PROVIDER='openai'
OPENAI_API_KEY='your-openai-api-key'
OPENAI_MODEL='your-model-id'
```

## Kimi

```dotenv
LLM_PROVIDER='kimi'
MOONSHOT_API_KEY='your-kimi-api-key'
MOONSHOT_BASE_URL='https://api.moonshot.cn/v1'
MOONSHOT_MODEL='your-model-id'
```

Replace `your-model-id` with a model ID available to your account. Both the Kimi base URL and model must be configured explicitly.

## Run

```bash
pnpm install
pnpm cli
```

Enter messages in the interactive terminal after startup. Type `exit` to quit.

Keep local settings in `.env` and do not commit it to Git. Include only example values in `.env.example`.

## Desktop settings

Run `pnpm start` to open the desktop app. Model settings can be edited in the app without editing files. Saving settings starts a new conversation and preserves saved memory.

The packaged app uses its own `.env` in the application support directory; it does not copy project credentials. For an isolated development profile, set `AGENT0_PROFILE_DIR` to an absolute directory path.

## MCP servers

### Built-in Filesystem

Open **MCP servers → Built-in Filesystem → Choose folder**, select the directory you want the agent to use, then choose **Save server**. No directory is accessible through this integration until you configure it. The selected folder and its subfolders support reading, writing, searching, and organizing files.

The app includes `@modelcontextprotocol/server-filesystem` and runs it with its own bundled runtime, so users do not need Node.js, pnpm, or a first-run download. Only the directory and enabled state are stored; executable paths are resolved from the current app installation, so moving the app does not invalidate the configuration.

The Filesystem card displays its allowed directory and connectivity. **Test connection** lists its tools, **Disable** removes it from subsequent conversations, and **Remove** clears its configuration. Reopen **Built-in Filesystem** to change the folder or configure it again. Folder access is limited by the filesystem server, including rejection of paths and symlinks that resolve outside the allowed directory.

### Local external servers

Open **MCP servers** in the desktop sidebar, then choose **Add server** and select **Local command (stdio)** as the connection type.

1. Enter a unique **Server ID**, such as `local-tools` (up to 24 lowercase letters, digits, hyphens, or underscores, starting with a letter).
2. Set **Command** to the server executable. For a Node.js server, use an absolute path to `node`; for a package runner, use an absolute path to `pnpm`. Desktop apps may not inherit your terminal's PATH.
3. Enter **Arguments** as a JSON array, such as `["/absolute/path/to/server.mjs"]`. Each entry is one argument; shell quoting and shell expansion are not applied.
4. Enter **Environment variables** as a JSON object of strings, such as `{"SERVICE_API_KEY":"your-key"}`. Only the MCP SDK's default process environment and these explicit variables are passed to external servers; model API keys are not automatically inherited.
5. Optionally set an absolute **Working directory**. Otherwise the server starts in the app's local configuration directory.
6. Choose **Test connection** to start a temporary process and inspect its tools, descriptions, and input schemas. Testing does not save the draft or call any tools, and closes the process afterward. The connection and tool listing have a 15-second deadline.
7. Choose **Save server**. Enable or disable saved servers from the list, or select a server ID to edit it. **Remove** deletes its saved configuration.

### Remote servers

Choose **Add server**, then select **Remote HTTP (Streamable HTTP)**. For services using the older SSE protocol, select **Remote SSE (legacy)** instead.

Enter a unique **Server ID** and the full **Server URL** supplied by the service, such as `https://example.com/mcp` or `https://example.com/sse`. Remote services do not require a command, arguments, or working directory.

For token authentication, enter **Request headers** as a JSON object:

```json
{"Authorization": "Bearer your-token"}
```

Custom headers such as `X-API-Key` are also supported. Leave the object as `{}` for unauthenticated services. Browser-based OAuth sign-in is not supported. Use the final endpoint URL: redirects and cross-origin SSE message endpoints are rejected. Protocol headers such as `Content-Type`, `Accept`, and MCP session headers are managed by the client.

Choose **Test connection** to retrieve the remote tool list, then **Save server**. Saved remote services use the same status checks, enable/disable controls, and tool routing as local services. URLs and authentication headers are stored in the app's local `.env` configuration.

### Status and storage

The server list checks connectivity when you open the panel, save a server, or enable it. Choose **Refresh status** to check all saved servers again. Each card shows Checking, Reachable, Connection failed, or Disabled; successful checks include the tool count, check duration, and timestamp. Failed checks include expandable error details. Disabled servers are not started. Reachable means the last temporary connection and tool listing succeeded; it does not indicate a continuously monitored connection. Refreshing status preserves the current conversation.

Saving, enabling, disabling, or removing a server closes existing MCP connections and starts a new conversation. Saved memory is preserved. Enabled servers connect on the next runtime initialization; if one cannot connect, the app reports its ID. Correct its configuration or disable it before retrying. The built-in `greet` demo remains available. External tool names include a server prefix and a hash to distinguish tools with the same name.

The app stores up to 16 server configurations in `MCP_SERVERS_BASE64` in its local `.env`. This is base64-encoded JSON to preserve quotes and multiline environment values, **not encryption**. The packaged app uses `~/Library/Application Support/agent0/.env`; development uses the project `.env` or the configured profile directory. The CLI reads the same variable from its `.env`.

Only configure commands you intend to run: testing and using a server launches its executable with your account's permissions. Server dependencies must already be available or installable by the configured package runner.
