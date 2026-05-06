# Semantic RAG (Retrieval-Augmented Generation)

Mesh uses a high-density semantic index to understand your codebase at scale. Unlike simple keyword searches, Semantic RAG allows Mesh to find code based on **meaning and intent**.

## How it Works

1. **Indexing:** Mesh scans your repository and breaks it down into "Symbols" (classes, functions, interfaces).
2. **Embedding:** These symbols are converted into high-dimensional vectors using NVIDIA's `nv-embedcode` models.
3. **Retrieval:** When you ask a question or request a change, Mesh calculates the "cosine similarity" between your request and the code symbols.
4. **Context Injection:** The most relevant symbols are injected into the LLM's prompt.

## Benefits of Semantic RAG

- **Massive Repositories:** Mesh can work with codebases that are far larger than any LLM's context window.
- **Dependency Awareness:** By finding related symbols, Mesh understands how changing one file might impact others.
- **Accurate Navigation:** Mesh can jump to the exact location of a bug even if you don't know the filename.

## Performance & Privacy

- **Local Processing:** Embeddings can be generated locally using `@xenova/transformers`, ensuring your code never leaves your infrastructure.
- **Incremental Updates:** The index is updated incrementally as you change files, so it's always "up to date" without requiring a full re-scan.
