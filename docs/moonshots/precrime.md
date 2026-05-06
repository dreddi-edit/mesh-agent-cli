# Precrime: Proactive Quality Control

In the world of Mesh, **Precrime** refers to the proactive identification and prevention of "code crimes" (bugs, security holes, and architectural drift) before they are even committed to your repository.

## Core Capabilities

### 🕵️ Security Auditing
Precrime scans every proposed change for:
- Hardcoded API keys or secrets.
- SQL injection vulnerabilities.
- Insecure dependency versions.
- Improper data handling patterns.

### 📐 Architectural Enforcement
It ensures that new code follows your project's established conventions:
- "Are we using the correct pattern for Error handling?"
- "Is this new module placed in the right directory?"
- "Does this follow our naming conventions?"

### 🏎️ Performance Guardrails
Precrime identifies potential bottlenecks:
- Unnecessary re-renders in frontend code.
- O(n^2) algorithms in critical paths.
- Redundant API calls or database queries.

## Integration

Precrime isn't a separate tool you have to run; it's integrated into the Mesh **Agent Loop**. Every time Mesh proposes a change, the `critic.ts` agent runs a Precrime check to validate the quality and safety of the proposal.

## Manual Execution
You can also ask Mesh to audit specific parts of your codebase:
> "Run a precrime scan on the `src/auth.ts` file and report any security risks."
