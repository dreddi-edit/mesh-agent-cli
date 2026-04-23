```
Mesh CLI SWE Benchmark
Model: us.anthropic.claude-opus-4-6-v1

case               resolved   tokens  latency  tools details
reverse-words          true    16534  21920ms      6 string-utils.js
  summary: Tests pass. Fixed `reverseWords` by changing `split("")` to `split(" ")` and `join("")` to `join(" ")` so it splits and rejoins on spaces, reversing word order instead of character order.
  toolTrace: workspace.search_files -> workspace.list_files -> workspace.read_file_raw -> workspace.read_file_raw -> workspace.patch_file -> workspace.run_command

Summary: resolved 100%
Summary: avg tokens 16534
Summary: avg latency 21920ms
```