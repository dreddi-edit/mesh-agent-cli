# mesh-llm-worker

Cloudflare Worker that proxies Bedrock Converse API requests for `mesh-agent-cli`.

End users never see the Bedrock API key — it lives as a Worker Secret.

## Deploy

```bash
cd worker
npm install
npx wrangler login                         # first time only
npx wrangler secret put BEDROCK_API_KEY    # paste the AWS Bedrock API key
npx wrangler deploy
```

The worker is live at `https://mesh-llm.<your-account>.workers.dev`.

## Optional: KV-based rate limiting

```bash
npx wrangler kv namespace create RATE_LIMIT
```

Uncomment the `[[kv_namespaces]]` block in `wrangler.toml` and paste the generated id.

## Endpoint

```
POST https://mesh-llm.<your-account>.workers.dev/model/{modelId}/converse
Content-Type: application/json

{ ...standard Bedrock Converse body... }
```

Request body is forwarded to `bedrock-runtime.<region>.amazonaws.com` as-is.

## Model allowlist

Set `ALLOWED_MODELS` in `wrangler.toml` to restrict which Bedrock models can be called.
Leave empty to allow everything.

For Anthropic on Bedrock, prefer inference-profile ids (for example `us.anthropic.claude-sonnet-4-5-20250929-v1:0`) instead of bare model ids, otherwise Bedrock can return an on-demand throughput validation error.

## Rotating the Bedrock key

```bash
npx wrangler secret put BEDROCK_API_KEY
```

No CLI redeploy needed — users keep working.
