# Release Runbook

This runbook is for publishing `@edgarelmo/mesh-agent-cli`.

## Pre-Release

1. Confirm the working tree contains only intended changes.
2. Run `npm run verify:release`.
3. Run `npm run publish:dry-run`.
4. Confirm `npm pack --dry-run` includes `README.md`, `CHANGELOG.md`, `docs/`, `dist/`, `scripts/`, `assets/`, and `LICENSE`.
5. Fresh-install the packed tarball on the release machine.

## Versioning

For private alpha fixes, use patch versions. For public beta readiness, use a minor version and write a dedicated changelog entry.

Current private-alpha release candidate: `0.3.11`.

## Publish

Only run after explicit human approval:

```bash
npm publish --access public
```

Then verify:

```bash
npm view @edgarelmo/mesh-agent-cli version
npx -p @edgarelmo/mesh-agent-cli mesh --version
npm run smoke:published
```

`npm run smoke:published` installs the published package into an isolated temporary global prefix, then verifies `mesh --version` and `mesh --help` without touching the user's real global npm prefix.

## Rollback

npm package versions cannot be reliably unpublished as a rollback strategy. Prefer dist-tag rollback:

```bash
npm dist-tag add @edgarelmo/mesh-agent-cli@<previous-good-version> latest
npm view @edgarelmo/mesh-agent-cli dist-tags
```

If a bad release exposes a severe issue, publish a patch release with the fix and move `latest` to it.

## Post-Release

- Create a Git tag matching the published version.
- Record the published package integrity from npm output.
- Run one clean published install smoke from the published package.
- Update the private-alpha user list with the exact version they should install.
