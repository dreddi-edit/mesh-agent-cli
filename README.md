# mesh-agent

Terminal AI agent with context compression. Like `claude` in your terminal — but Mesh compresses tool results so large codebases stay within the model's context window.

**Zero config.** No AWS credentials needed. Install, run, done.

```bash
npm i -g @edgarelmo/mesh-agent-cli
mesh-agent
```

---

## How it works

```
your prompt → Cloudflare Worker (injects Bedrock key) → Claude
                                                            ↓
your terminal ←── compressed result ←── Mesh pipeline ←── tool call
```

- Tool outputs (file reads, grep, ls) are compressed before being sent back to the model
- Large workspaces stay within context without manual trimming
- Session capsules summarize older conversation turns automatically

---

## Usage

```bash
# Interactive
mesh-agent

# One-shot
mesh-agent "what does this codebase do"

# Log out
mesh-agent logout
```

**Slash commands inside the REPL:**

| Command | Description |
|---|---|
| `/index` | Cache the workspace for faster reads |
| `/model [pick\|list\|id]` | Switch model live |
| `/capsule` | Inspect or compact the session summary |
| `/status` | Show index, session, and cloud state |
| `/cost` | Token usage + estimated cost |
| `/approvals [on\|off]` | Toggle approval prompts for write/run tools |
| `/doctor` | Runtime diagnostics |
| `/setup` | Settings wizard |
| `/help` | All commands |

---

## Models

| Alias | Model | Notes |
|---|---|---|
| `sonnet4.6` | Claude Sonnet 4.6 | default |
| `opus4.6` | Claude Opus 4.6 | most capable |
| `haiku4.5` | Claude Haiku 4.5 | fastest |

Switch mid-session: `/model sonnet4.6` or `/model pick` for an interactive chooser.

---

## Config

All optional. Common overrides via env or `/setup`:

| Env var | Purpose |
|---|---|
| `BEDROCK_MODEL_ID` | Override default model |
| `BEDROCK_MAX_TOKENS` | Cap tokens per response |
| `WORKSPACE_ROOT` | Override working directory |
| `AGENT_MODE` | `local` (default) or `mcp` |

---

## BYOK — bring your own Bedrock key

Bypass the shared proxy and use your own Bedrock account:

```bash
export BEDROCK_ENDPOINT=https://bedrock-runtime.us-east-1.amazonaws.com
export AWS_BEARER_TOKEN_BEDROCK=<your-key>
mesh-agent
```

---

## Project-local settings

Running `mesh-agent` in a new directory prompts to create a `.mesh/` folder:

```
.mesh/
  instructions.md     # project-specific agent instructions
  architecture.md     # high-level architecture notes
  dependency_graph.md # key dependencies
  history/            # session capsule history
```

Edit `instructions.md` to give the agent context about your codebase conventions, stack, and preferences. It's injected into every system prompt.

---

## MCP mode

Run tools via an external MCP server instead of in-process:

```bash
export AGENT_MODE=mcp
export MESH_MCP_COMMAND=node
export MESH_MCP_ARGS='["./my-mcp-server.js"]'
mesh-agent
```

---

## License

MIT
