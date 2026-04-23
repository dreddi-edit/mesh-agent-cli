This directory contains file-based SWE benchmark cases for `bench:mesh:swe`.

Each case lives in its own folder:

- `case.json`: metadata for the task
- `files/`: the buggy workspace snapshot to materialize in a temp directory

Expected `case.json` shape:

```json
{
  "id": "example-case",
  "title": "Short bug title",
  "issue": "Bug description shown to the model.",
  "verifyCommand": "node --test test/*.test.js"
}
```

Guidelines:

- Keep cases self-contained and deterministic.
- Prefer a single verifier command with clear pass/fail semantics.
- Use small but realistic multi-file layouts where possible.
- Add harder cases over time instead of modifying existing ones, so scores remain comparable.
