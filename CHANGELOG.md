# Changelog

## 0.3.21 - Local Security Hardening

### Changed

- Hardened the local dashboard flow so the API token is delivered out-of-band by the CLI launcher and is no longer rendered into server-generated HTML.
- Made workspace MCP loading opt-in by default; enable it explicitly with `includeWorkspaceMcp: true` or `MESH_ENABLE_WORKSPACE_MCP=1`.
- Reduced MCP subprocess environment inheritance to a small allowlist by default. Use `MESH_MCP_ENV_ALLOWLIST` for specific env names, or `MESH_MCP_INHERIT_ENV=1` only for trusted servers.
- Tightened `workspace.run_command` safety checks around credential file reads, environment dumps, command substitution, and nested shell execution.

### Fixed

- Fixed daemon socket permission hardening so `daemon.sock` is chmodded after `listen()` creates it, with daemon state/PID files written owner-only.
- Ignored `.env.*` files while keeping `.env.example` trackable.

## 0.3.11 - Username Login Polish

### Added

- Added email-or-username terminal login so users do not need to type `@` on terminals/keyboards where that is awkward.
- Added Supabase migration for `public.mesh_resolve_login_identifier(identifier text)`.

### Changed

- Login now resolves username metadata, preferred username metadata, or the unique email local-part before password authentication.

## 0.3.10 - Private Alpha Readiness

### Added

- Added `npm run verify:release` as the required publish gate.
- Added `npm run smoke:release` for isolated tarball install checks.
- Added `npm run smoke:published` for isolated global-prefix verification of the published package.
- Added `npm run publish:dry-run` for npm release rehearsal.
- Added `/doctor` checks for workspace writability, Mesh state path, release guardrails, and network timeouts.
- Added `mesh init` and `/start` for the first-user golden path.
- Added `/change <small goal>` for narrow verified code changes.
- Added `mesh support` for auth-free bug report diagnostics.
- Added Go-Live, Privacy, and Support documentation under `docs/`.

### Changed

- Persistent index embeddings are opt-in via `MESH_ENABLE_EMBEDDINGS=1`.
- Background resolver is opt-in via `MESH_ENABLE_BACKGROUND_RESOLVER=1`.
- Watchers are no longer recursive across the full repo and can be disabled with `MESH_DISABLE_WATCHERS=1`.
- Test runner disables watchers by default for deterministic CI/local runs.
- `/doctor fix` applies safe local setup repairs while leaving shell, Git, and auth changes manual.
- Authentication no longer hard-fails when the OS keychain native module is unavailable; Mesh falls back to a `0600` session file.

### Fixed

- Fixed `EMFILE: too many open files, watch` crashes from recursive watchers.
- Fixed streaming hazard test drift for null/undefined property access.
- Restored unsafe chained environment variable access detection.
- Fixed persistent indexing hang caused by default remote embeddings.

### Known Constraints

- Public self-serve launch still requires hosted proxy quotas, dashboards, and external dogfooding.
- Retry tests still use real backoff timing and keep the full test suite around 20-25 seconds.
