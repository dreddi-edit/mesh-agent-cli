# Project Architecture 🏛️

## 🛸 The Mesh Philosophy
Mesh is a **Capsule-First** terminal agent. It prioritizes semantic summaries (capsules) over raw file content to maximize token efficiency and reasoning speed.

## 📦 Directory Structure
- `src/`: Core logic and CLI entry point.
- `.mesh/`: Project intelligence, instructions, and architectural maps.
- `dist/`: Compiled production code.

## 🔄 The Agent Loop
1.  **Initialize:** Load local `.mesh` settings and instructions.
2.  **Contextualize:** Read capsules for requested workspace areas.
3.  **Execute:** Use localized tools (`patch_file`, `git_status`) to fulfill requests.
4.  **Reflect:** Update session capsules for continuity.

---
*Maintained by Mesh Intelligence.*
