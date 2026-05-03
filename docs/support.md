# Support Runbook

Use this runbook for private alpha users.

## Required Bug Report Data

Ask users for:

- Mesh version: `mesh --version`
- Support snapshot: `mesh support`
- Install path: `which mesh`
- Node version: `node --version`
- OS and shell
- Output of `mesh doctor full`
- The command or prompt that failed
- The relevant error text
- Whether `.mesh/` may be shared

Do not ask for full source archives by default. Prefer targeted snippets, error output, and `.mesh/` artifacts that the user explicitly approves.

## Triage Buckets

- Install failure: npm, native dependency, PATH, Node version, keytar.
- First-run failure: auth, endpoint, missing token, config parsing.
- Login failure: confirm whether the user used email or username; username login requires the Supabase `mesh_resolve_login_identifier` migration.
- Workspace failure: permissions, Git unavailable, state path not writable.
- Model failure: provider status, quota/rate limit, fallback model behavior.
- Tool failure: command safety block, timeout, file read/write validation.
- Quality issue: wrong answer, missing citations, bad patch, incomplete verification.

## First Response

1. Ask the user to run `mesh support` and `mesh doctor full`.
2. Confirm whether the failure reproduces on `mesh --help` or only inside a workspace.
3. If install-related, run the release smoke locally before debugging further.
4. If model-related, check proxy health, quota, and fallback model logs.
5. If code-edit-related, ask for the generated diff and verification command output.

## Escalation Criteria

Block the release or pause onboarding if:

- `mesh --version` fails after a fresh install.
- `/doctor` crashes instead of reporting failures.
- `/index` hangs longer than 60 seconds on a normal small repo.
- Any default flow uploads telemetry without explicit opt-in.
- A background feature runs without the corresponding environment flag.
