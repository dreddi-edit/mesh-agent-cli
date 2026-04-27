# Mesh CLI — Investor-Ready Sprint

## What This Is

Mesh is a terminal-first AI engineering agent that turns repositories into inspectable, testable, and self-improving workspaces. It's a CLI tool (published as `@edgarelmo/mesh-agent-cli`) running on Node.js/TypeScript, using Claude via AWS Bedrock for AI capabilities. Users interact through slash commands (`/index`, `/hologram`, `/precrime`, etc.) that analyze code, debug runtime issues, and produce verifiable artifacts in `.mesh/`.

## Core Value

Every slash command must produce reliable, provable output that can be demonstrated to investors — not just chat responses, but persistent artifacts in `.mesh/` that prove the tool works.

## Requirements

### Validated

- ✓ CLI framework and agent loop — existing
- ✓ AWS Bedrock LLM integration — existing
- ✓ Tool backend architecture (local + MCP) — existing
- ✓ Workspace indexing with tree-sitter — existing
- ✓ Timeline system (git worktrees) — existing
- ✓ Dashboard server — existing
- ✓ Session capsule persistence — existing
- ✓ Multi-agent system (agent-os) — existing
- ✓ Moonshot engines (precrime, self-defend, semantic-git, etc.) — existing
- ✓ Voice mode — existing
- ✓ Auth system with keytar — existing

### Active

- [ ] Every slash command runs without errors and produces meaningful output
- [ ] Command results persist as files in `.mesh/` (not just chat output)
- [ ] Dashboard shows insights from command results
- [ ] LLM responses are clean — no weird characters, proper formatting
- [ ] User gets clear feedback on what the LLM is doing (transparency/progress)
- [ ] LLM backend is correctly configured and reliable (Bedrock vs Worker clarity)
- [ ] Output formatting is polished and professional (markdown, tables, structure)
- [ ] Error handling is graceful — no raw stack traces or cryptic failures

### Out of Scope

- Modularizing the monolithic files (local-tools.ts, agent-loop.ts) — too risky for a 1-day sprint
- Adding new features or commands — focus on fixing what exists
- Mobile/web clients — terminal only
- Type system cleanup (80+ `as any`) — cosmetic, not user-facing
- Comprehensive test suite — no time, focus on manual verification

## Context

- **Deadline:** 28. April 2026 abends (Investor-Präsentation)
- **LLM Backend:** AWS Bedrock (Account 960583973825, us-east-1). Cloudflare Worker exists as proxy but unclear if active. Need to verify the actual call chain.
- **Current State:** Many slash commands fail or produce empty/broken output. LLM responses have formatting artifacts. No persistent output for most commands. Dashboard exists but may not reflect command results.
- **Codebase:** ~15,000 lines of core TypeScript across two monolithic files (agent-loop.ts, local-tools.ts) plus ~22 moonshot engines and supporting infrastructure.
- **Version:** 0.2.98, published to npm

## Constraints

- **Timeline**: 1 day (morgen Abend). Every hour counts.
- **Risk tolerance**: Low — we fix, not refactor. Minimal structural changes.
- **LLM cost**: AWS Bedrock billing — keep token usage reasonable but quality matters more.
- **Testing**: Manual verification only — run each command, check output.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Fix-only sprint, no refactoring | 1-day deadline, structural changes too risky | — Pending |
| .mesh/ as artifact store | Investors need to see persistent, provable output | — Pending |
| Dashboard integration for insights | Visual proof of capabilities beyond terminal | — Pending |
| Prioritize command reliability over new features | Broken demo is worse than missing features | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-27 after initialization*
