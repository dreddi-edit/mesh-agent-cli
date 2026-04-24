# Mesh

Terminal-first AI engineering agent with local code intelligence, speculative timelines, runtime debugging, and worker orchestration.

```bash
npm i -g @edgarelmo/mesh-agent-cli
mesh
```

- **Voice**: `/voice` local Speech-to-Speech.
- **Voice Setup**: `mesh doctor voice fix` installs core voice dependencies on macOS via Homebrew and uses Homebrew's Whisper runtime fallback when no local model exists.
- **Code Intelligence**: `workspace.ask_codebase({ query, mode })`, `workspace.explain_symbol`, and `workspace.impact_map` use a persistent local index under `~/.config/mesh/indexes/<workspace-hash>`.
- **Speculative Timelines**: `workspace.timeline_create`, `workspace.timeline_apply_patch`, `workspace.timeline_run`, `workspace.timeline_compare`, and `workspace.timeline_promote` verify candidate edits in isolated git worktrees or checkout copies before touching the main workspace.
- **Agent OS**: `.mesh/agents/*.md` role definitions feed `agent.spawn`, `agent.status`, `agent.review`, and `agent.merge_verified`.
- **Runtime Cognition**: `.mesh/runbooks/*.json` profiles feed `runtime.start`, `runtime.capture_failure`, `runtime.trace_request`, `runtime.explain_failure`, and `runtime.fix_failure`.
- **Terminal Frontend Preview**: `/preview <url> [widthxheight]` captures real Chromium screenshots via CDP and renders inline with Kitty, iTerm2, or Sixel when supported.
- **Control Plane**: `/dashboard` remains the local supervision view for code graph and live tool events.

UNLICENSED — All rights reserved.
