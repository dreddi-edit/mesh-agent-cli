# mesh-agent

Terminal AI agent for Mesh. Like `claude` in your terminal, but with Mesh's
compression logic on tool results so large workspaces stay within context.

Zero config: installs, runs, done. No AWS credentials needed.

## Install

```bash
npm i -g @edgarelmo/mesh-agent-cli
```

## Use

One-shot question:

```bash
mesh-agent "welche files liegen hier"
```

Interactive:

```bash
mesh-agent
```

Type `exit` to quit.  
Use `/model` to show current model and `/model <bedrock-model-id>` to switch live.

## How it works

- User input → Bedrock Converse request through the shared Mesh LLM proxy.
- Model decides: answer directly, or call a tool.
- Tool runs locally in your workspace, result gets Mesh-compressed before
  going back to the model.
- Loop until the model returns a final answer.

No Bedrock/AWS credentials live on your machine — the proxy (a Cloudflare
Worker) injects the key server-side.

## Modes

- `local` (default): local workspace tools, in-process.
- `mcp`: tool backend runs as an external MCP server (stdio). Set
  `AGENT_MODE=mcp` and configure `MESH_MCP_COMMAND` / `MESH_MCP_ARGS`.

## Config (all optional)

See `.env.example`. Common overrides:

| Env var               | Purpose                                    |
| --------------------- | ------------------------------------------ |
| `BEDROCK_MODEL_ID`    | Pick a different Bedrock model.            |
| `BEDROCK_ENDPOINT`    | Point at your own proxy or Bedrock direct. |
| `AWS_BEARER_TOKEN_BEDROCK` | Required for BYOK direct-to-Bedrock.  |
| `BEDROCK_BEARER_TOKEN` / `BEDROCK_API_KEY` | Alias to pass the same bearer token. |
| `BEDROCK_MAX_TOKENS`  | Cap per response.                          |
| `WORKSPACE_ROOT`      | Override working dir for local tools.      |

## BYOK (bring your own Bedrock key)

If you want to bypass the shared proxy and pay your own Bedrock bill:

```bash
export BEDROCK_ENDPOINT=https://bedrock-runtime.us-east-1.amazonaws.com
export AWS_BEARER_TOKEN_BEDROCK=<your-bedrock-api-key>
mesh-agent
```

## Repository

Source + Cloudflare Worker live here:
https://github.com/dreddi-edit/mesh-agent-cli

## License

MIT
