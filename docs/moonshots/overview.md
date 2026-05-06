# Moonshot Workflows

"Moonshots" are high-autonomy, specialized pipelines in Mesh designed to handle complex engineering tasks that go beyond simple file edits.

## 🕵️ Causal Autopsy
**Goal:** Automatically fix failing tests or runtime errors.

When a test fails, Causal Autopsy:
1. **Introspects:** Analyzes the stack trace and relevant source code.
2. **Hypothesizes:** Identifies the most likely cause of failure.
3. **Drafts:** Creates a fix in an isolated timeline.
4. **Validates:** Runs the tests again to confirm the fix works.
5. **Reports:** Presents the verified fix to the user.

## 🛡️ Precrime
**Goal:** Proactive security and quality auditing.

Precrime runs in the background or on-demand to:
- Scan for hardcoded secrets or sensitive patterns.
- Identify potential race conditions or performance bottlenecks.
- Audit new dependencies for known vulnerabilities.

## ⚡ Ephemeral Execution
**Goal:** Risk-free experimentation.

Allows the agent to spin up temporary environments to run code, verify API responses, or benchmark performance without polluting your local workspace.

## 🧠 Hive Mind
**Goal:** Multi-agent collaboration.

Orchestrates multiple specialized sub-agents (e.g., a "Security Agent", a "Performance Expert", and a "Code Architect") to review and refine complex pull requests before they are finalized.

## 🌊 Fluid Mesh
**Goal:** Real-time environment synchronization.

Maintains a bidirectional link between the Mesh Agent, your IDE, and the terminal state, ensuring the agent always has the "ground truth" of what you are seeing and doing.
