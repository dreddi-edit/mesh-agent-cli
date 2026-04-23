```
Mesh CLI SWE Benchmark
Model: us.anthropic.claude-opus-4-6-v1

case               mode     resolved   tokens  latency  tools details
clamp-percentage   direct       true      505   3183ms      0 src/math.js
  summary: Fix clampPercentage to clamp values to 0-100 by adding Math.min(100, ...) upper bound
clamp-percentage   mesh         true    11511  14197ms      4 src/math.js
  summary: All tests pass. The fix adds `Math.min(100, ...)` to cap the upper bound, so `clampPercentage` now correctly clamps values to the 0–100 range.
  toolTrace: workspace.grep_content -> workspace.read_file_raw -> workspace.patch_file -> workspace.run_command
config-default-port direct       true      468   3191ms      0 src/config.js
  summary: Fix loadPort to return fallback instead of parsed when parsed is not > 0
config-default-port mesh         true    14130  18819ms      5 src/config.js
  summary: All tests pass. The fix: changed the else branch of the ternary in `loadPort` to return `fallback` instead of `parsed`, so invalid/non-positive numbers correctly fall back to the default port.
  toolTrace: workspace.list_files -> workspace.read_file_raw -> workspace.read_file_raw -> workspace.patch_file -> workspace.run_command
open-items-filter  direct       true      510   3805ms      0 src/items.js
  summary: Fix filter logic in getOpenItems to exclude done items by changing === to !==
open-items-filter  mesh         true    14185  17625ms      5 src/items.js
  summary: Tests pass. Changed `=== "done"` to `!== "done"` in the filter so `getOpenItems` correctly excludes completed items.
  toolTrace: workspace.list_files -> workspace.read_file_raw -> workspace.read_file_raw -> workspace.patch_file -> workspace.run_command
query-string-skip-empty direct      false        0   4314ms      0 -
  error: Unexpected token 'L', "Looking at"... is not valid JSON
query-string-skip-empty mesh         true    14334  17174ms      5 src/query.js
  summary: Test passes. The fix adds `value !== ""` to the filter in `buildQueryString` so that empty strings are omitted alongside `null` and `undefined`.
  toolTrace: workspace.list_files -> workspace.read_file_raw -> workspace.read_file_raw -> workspace.patch_file -> workspace.run_command
retry-after-ms     direct       true      501   2636ms      0 src/http.js
  summary: Fix parseRetryAfterMs to convert seconds to milliseconds by multiplying by 1000
retry-after-ms     mesh         true    11726  15383ms      4 src/http.js
  summary: All tests pass. The fix multiplies the parsed seconds by 1000 to correctly convert to milliseconds.
  toolTrace: workspace.grep_content -> workspace.read_file_raw -> workspace.patch_file -> workspace.run_command
reverse-words      direct       true      441   3025ms      0 src/string-utils.js
  summary: Fix reverseWords to reverse word order instead of character order by splitting on spaces, reversing, and joining with spaces.
reverse-words      mesh         true    16530  19663ms      6 src/string-utils.js
  summary: Tests pass. Fixed `reverseWords` by changing `split("")` to `split(" ")` (and `join("")` to `join(" ")`) so it splits and rejoins on spaces, reversing word order instead of character order.
  toolTrace: workspace.search_files -> workspace.list_files -> workspace.read_file_raw -> workspace.read_file_raw -> workspace.patch_file -> workspace.run_command
slugify-trim       direct      false        0   4614ms      0 -
  error: Unexpected token 'L', "Looking at"... is not valid JSON
slugify-trim       mesh         true    14077  17080ms      5 src/slug.js
  summary: All tests pass. Changed `\s` to `\s+` in the regex so consecutive whitespace characters are collapsed into a single dash.
  toolTrace: workspace.list_files -> workspace.read_file_raw -> workspace.read_file_raw -> workspace.patch_file -> workspace.run_command
status-label       direct       true      495   3261ms      0 src/status.js
  summary: Fix formatStatusLabel to return title-cased 'In Progress' for 'in_progress' status instead of the raw lowercase string.
status-label       mesh         true     8906  11980ms      3 src/status.js
  summary: All tests pass. The fix changes the `"in_progress"` case in `formatStatusLabel` to return `"In Progress"` instead of the raw lowercase `"in_progress"`.
  toolTrace: workspace.grep_capsules -> workspace.patch_file -> workspace.run_command

Summary: direct resolved 75.0%
Summary: mesh resolved 100.0%
Summary: direct avg tokens 365, mesh avg tokens 13175
Summary: direct avg latency 3504ms, mesh avg latency 16490ms
```