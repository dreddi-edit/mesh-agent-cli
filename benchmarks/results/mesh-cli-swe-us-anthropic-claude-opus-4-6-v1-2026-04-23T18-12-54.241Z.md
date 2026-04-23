```
Mesh CLI SWE Benchmark
Model: us.anthropic.claude-opus-4-6-v1

case               resolved   tokens  latency  tools details
reverse-words          true    16535  20043ms      6 string-utils.js
  summary: Tests pass. Fixed `reverseWords` by changing `split("")` to `split(" ")` (and `join("")` to `join(" ")`) so it splits and rejoins on spaces, reversing word order instead of character order.
  toolTrace: workspace.search_files -> workspace.list_files -> workspace.read_file_raw -> workspace.read_file_raw -> workspace.patch_file -> workspace.run_command
config-default-port     true    14279  19700ms      5 config.js
  summary: All tests pass. The fix changes the false branch of the ternary in `loadPort` to return `fallback` instead of `parsed`, so invalid/non-positive inputs correctly fall back to the default port.
  toolTrace: workspace.list_files -> workspace.read_file_raw -> workspace.read_file_raw -> workspace.patch_file -> workspace.run_command
status-label           true     8904  11961ms      3 status.js
  summary: All tests pass. The fix changes the `"in_progress"` case in `formatStatusLabel` to return `"In Progress"` instead of the raw lowercase `"in_progress"`.
  toolTrace: workspace.grep_capsules -> workspace.patch_file -> workspace.run_command

Summary: resolved 100%
Summary: avg tokens 13239
Summary: avg latency 17235ms
```