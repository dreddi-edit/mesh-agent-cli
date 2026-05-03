# Mesh Go-Live Checklist

Use this checklist before inviting external users into a workspace.

## Release Gate

Run from the repository root:

```bash
npm run verify:release
```

This runs typecheck, build, tests, and an isolated package smoke test that installs the packed tarball into a temporary project and verifies the installed `mesh` binary.

If a network-isolated machine cannot install dependencies during smoke, pre-warm the npm cache or run the smoke on the release machine that will publish the package.

## First Workspace Gate

In the user's target repository:

```text
mesh init
```

or inside an existing Mesh session:

```text
/start
explain the main runtime path with citations
```

Treat `/doctor` failures as blockers for a first user session. `/doctor fix` may apply safe local repairs such as creating `.mesh/`, state directories, and workspace config. Warnings are acceptable only if they are intentional, for example telemetry contribution or embeddings enabled for a controlled pilot.

If a user reports install or startup issues, collect `mesh support` and `mesh doctor full` before asking for repo-specific files.

## Golden Path

The first supported workflow should stay narrow:

1. Install Mesh.
2. Run `mesh init` or `/start`.
3. Ask a repo-understanding question with citations.
4. Run `/change <small goal>` for one narrow code change.
5. Run verification through the repo's existing test/build command if Mesh did not detect one.
7. Inspect the produced `.mesh/` artifacts.

Do not lead with experimental moonshot workflows for first-time users.

## Privacy Defaults

Mesh stores project artifacts in `.mesh/` and per-workspace state under `~/.config/mesh/` unless `MESH_STATE_DIR` overrides it.

Telemetry contribution to Mesh Brain is opt-in and disabled by default. When enabled, contributions should be treated as metadata about errors, diff patterns, and verification outcomes, not as a license to upload arbitrary source.

Background resolver, embeddings, vision analysis, and production telemetry connectors are opt-in or explicit-command flows because they can affect CPU, network, provider cost, or privacy.

## Cost Guardrails

Use these controls before public onboarding:

- `AGENT_MAX_STEPS` limits the per-turn tool/model loop. Default: `8`.
- `BEDROCK_MAX_TOKENS` caps output tokens per model call. Default: `3000`.
- `BEDROCK_FALLBACK_MODEL_IDS` limits fallback routing to known models.
- `MESH_ENABLE_EMBEDDINGS` must stay off unless the user accepts model loading or remote embedding cost.
- `MESH_ENABLE_BACKGROUND_RESOLVER` must stay off unless the user accepts background diagnostics.
- Proxy-level rate limits and daily user quotas should be configured on the hosted model gateway before public beta.

## Feature Flags

Default-safe:

- `MESH_DISABLE_WATCHERS=1`: disables file watchers, useful in CI and constrained OS environments.
- `MESH_STATE_DIR=/path/to/state`: isolates state for smoke tests and pilots.

Opt-in:

- `MESH_ENABLE_BACKGROUND_RESOLVER=1`: enables background diagnostics after watched file changes.
- `MESH_ENABLE_EMBEDDINGS=1`: enables vector embeddings during persistent index work.
- `MESH_BRAIN_ENDPOINT=https://...`: sends opted-in Mesh Brain contributions to a remote endpoint.

## Public Beta Bar

Before a public beta, require:

- `npm run verify:release` green on the release machine.
- Fresh install verified via `npm install -g` or the published package.
- `npm run smoke:published` green after the package is published.
- `mesh support` works without authentication.
- Five external repositories dogfooded, including at least one monorepo and one repo with no existing tests.
- A documented rollback path for the npm release.
- Hosted proxy quotas, rate limits, and error dashboards enabled.
