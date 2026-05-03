# Changelog

## 0.3.10 - Private Alpha Readiness

### Added

- Added `npm run verify:release` as the required publish gate.
- Added `npm run smoke:release` for isolated tarball install checks.
- Added `npm run smoke:published` for isolated global-prefix verification of the published package.
- Added `npm run publish:dry-run` for npm release rehearsal.
- Added `/doctor` checks for workspace writability, Mesh state path, release guardrails, and network timeouts.
- Added `mesh init` and `/start` for the first-user golden path.
- Added `/change <small goal>` for narrow verified code changes.
- Added Go-Live, Privacy, and Support documentation under `docs/`.

### Changed

- Persistent index embeddings are opt-in via `MESH_ENABLE_EMBEDDINGS=1`.
- Background resolver is opt-in via `MESH_ENABLE_BACKGROUND_RESOLVER=1`.
- Watchers are no longer recursive across the full repo and can be disabled with `MESH_DISABLE_WATCHERS=1`.
- Test runner disables watchers by default for deterministic CI/local runs.
- `/doctor fix` applies safe local setup repairs while leaving shell, Git, and auth changes manual.

### Fixed

- Fixed `EMFILE: too many open files, watch` crashes from recursive watchers.
- Fixed streaming hazard test drift for null/undefined property access.
- Restored unsafe chained environment variable access detection.
- Fixed persistent indexing hang caused by default remote embeddings.

### Known Constraints

- Public self-serve launch still requires hosted proxy quotas, dashboards, and external dogfooding.
- Retry tests still use real backoff timing and keep the full test suite around 20-25 seconds.
