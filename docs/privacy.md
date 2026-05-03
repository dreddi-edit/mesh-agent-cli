# Privacy and Telemetry

Mesh is designed to be local-first for source inspection and workspace artifacts.

## Local Data

Mesh writes project-local artifacts under `.mesh/`. These may include indexes, summaries, audit logs, runbooks, timelines, production-signal snapshots, and generated reports.

Mesh writes per-user/per-workspace state under `~/.config/mesh/` by default. Set `MESH_STATE_DIR` to isolate state for pilots, CI, or regulated environments.

## Model Calls

When Mesh needs LLM assistance, relevant prompt context may be sent to the configured model endpoint. Users should assume snippets, summaries, commands, errors, and tool results can be included in model calls when needed to complete the requested task.

Use raw file reads and large-context operations deliberately. The default capsule/index flows reduce source volume, but they are not a privacy boundary if a task requires model reasoning over code.

## Telemetry Contribution

Mesh Brain contribution is opt-in and disabled by default. When enabled, contributions are intended to contain error signatures, normalized diff patterns, verification outcomes, and learned repair metadata.

Do not enable contribution for private or regulated code unless the configured Mesh Brain endpoint and data policy have been reviewed.

## Opt-In Features

These features can affect CPU, network use, provider cost, or privacy and are off by default:

- `MESH_ENABLE_BACKGROUND_RESOLVER=1`: runs background diagnostics after watched file changes.
- `MESH_ENABLE_EMBEDDINGS=1`: enables local or remote embeddings for persistent index work.
- `MESH_BRAIN_ENDPOINT=https://...`: enables remote destination for opted-in Mesh Brain contributions.

## First-User Policy

For private alpha users, run `/doctor` before real work. Warnings for telemetry, embeddings, or background resolver should be treated as explicit consent checks, not cosmetic output.
