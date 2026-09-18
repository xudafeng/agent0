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
