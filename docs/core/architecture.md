# Architecture & Core Concepts

Mesh is not just a CLI; it's an **Agentic Operating System** designed for deterministic, high-quality code generation and verification.

## High-Level Architecture

The system is built on four primary pillars that work in tandem to provide a seamless agentic experience.

### 1. The Agent Loop (`src/agent-loop.ts`)
The central nervous system. It handles:
- **Interaction:** Managing the terminal UI and user input.
- **Orchestration:** Breaking down complex user requests into executable tool calls.
- **Memory Management:** Keeping track of the conversation history and context budget.

### 2. Context Assembler (`src/context-assembler.ts`)
The "Eye" of Mesh. It builds a high-density context for the LLM by combining:
- **Semantic RAG:** Pulling relevant code snippets from the vector index.
- **Runtime State:** Injecting current environment variables, folder structures, and active processes.
- **Timeline State:** Including diffs from active worktrees.

### 3. Local Tool Backend (`src/local-tools.ts`)
The "Hands" of Mesh. Over 80+ tools are available, categorized into:
- **Workspace I/O:** `read_file`, `write_file`, `replace`, `list_directory`.
- **Analysis:** `grep_search`, `glob`, `tree-sitter` parsing.
- **Execution:** `run_shell_command`, `git_operations`.
- **System:** `search_web`, `read_url`.

### 4. Mesh Core (`mesh-core/`)
The engine room. This low-level layer handles AST (Abstract Syntax Tree) operations, compression algorithms, and workspace helpers that ensure tool calls are precise and surgical.

---

## The Concept of "Timelines"

One of Mesh's most unique features is the **Timeline Manager**. 

Unlike standard agents that edit files directly in your working directory, Mesh can create "Ghost Timelines" (isolated worktrees).
- **Isolation:** Tests are run in a cloned environment without affecting your main work.
- **Verification:** Changes are only promoted back to the main branch if all verification steps (tests, linting, type-checking) pass.
- **Traceability:** Every change is logged and can be reverted atomically.

## Semantic RAG & Vector Indexing

Mesh builds a local vector index of your repository using NVIDIA `nv-embedcode` models. This allows it to:
- Find code by **intent** rather than just keyword matches.
- Understand cross-file dependencies without reading every file into the prompt.
- Scale to massive repositories while staying within the LLM's token limit.
