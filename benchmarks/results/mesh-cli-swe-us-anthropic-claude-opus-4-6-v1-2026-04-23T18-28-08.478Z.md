```
Mesh CLI SWE Benchmark
Model: us.anthropic.claude-opus-4-6-v1

case               mode     resolved   tokens  latency  tools details
clamp-percentage   direct       true      505   3042ms      0 src/math.js
  summary: Fix clampPercentage to clamp values to 0-100 by adding Math.min(100, ...) upper bound
clamp-percentage   mesh         true    11511  14081ms      4 src/math.js
  summary: All tests pass. The fix adds `Math.min(100, ...)` to cap the upper bound, so `clampPercentage` now correctly clamps values to the 0–100 range.
  toolTrace: workspace.grep_content -> workspace.read_file_raw -> workspace.patch_file -> workspace.run_command
config-default-port direct       true      469   2655ms      0 src/config.js
  summary: Fix loadPort to return fallback instead of parsed when parsed is not > 0
config-default-port mesh         true    14129  19797ms      5 src/config.js
  summary: All tests pass. The fix changes the false branch of the ternary in `loadPort` to return `fallback` instead of `parsed`, so invalid/non-positive numbers correctly fall back to the default port.
  toolTrace: workspace.list_files -> workspace.read_file_raw -> workspace.read_file_raw -> workspace.patch_file -> workspace.run_command
open-items-filter  direct       true      510   2868ms      0 src/items.js
  summary: Fix filter logic in getOpenItems to exclude done items by changing === to !==
open-items-filter  mesh         true    14213  18794ms      5 src/items.js
  summary: Tests pass. The fix changed `=== "done"` to `!== "done"` in the filter predicate so `getOpenItems` now correctly excludes completed items.
  toolTrace: workspace.list_files -> workspace.read_file_raw -> workspace.read_file_raw -> workspace.patch_file -> workspace.run_command
query-string-skip-empty direct       true     1082  15535ms      0 src/query.js
  summary: Add empty string to the filter condition in buildQueryString so empty strings are skipped along with null and undefined.
query-string-skip-empty mesh         true    14148  17232ms      5 src/query.js
  summary: Tests pass. The fix adds `value !== ""` to the filter in `buildQueryString` so that empty strings are omitted from the query string alongside `null` and `undefined`.
  toolTrace: workspace.list_files -> workspace.read_file_raw -> workspace.read_file_raw -> workspace.patch_file -> workspace.run_command
retry-after-ms     direct       true      501   2602ms      0 src/http.js
  summary: Fix parseRetryAfterMs to convert seconds to milliseconds by multiplying by 1000
retry-after-ms     mesh         true    11726  14202ms      4 src/http.js
  summary: All tests pass. The fix multiplies the parsed seconds by 1000 to correctly convert to milliseconds.
  toolTrace: workspace.grep_content -> workspace.read_file_raw -> workspace.patch_file -> workspace.run_command
reverse-words      direct       true      441   3235ms      0 src/string-utils.js
  summary: Fix reverseWords to reverse word order instead of character order by splitting on spaces, reversing, and joining with spaces.
reverse-words      mesh         true    16528  19723ms      6 src/string-utils.js
  summary: Tests pass. Fixed `reverseWords` by changing `split("")` to `split(" ")` and `join("")` to `join(" ")` so it splits and rejoins on spaces, reversing word order instead of character order.
  toolTrace: workspace.search_files -> workspace.list_files -> workspace.read_file_raw -> workspace.read_file_raw -> workspace.patch_file -> workspace.run_command
slugify-trim       direct       true     1076   6972ms      0 src/slug.js
  summary: Replace /\s/g with /\s+/g so consecutive whitespace characters are collapsed into a single dash
slugify-trim       mesh         true    14085  16738ms      5 src/slug.js
  summary: Tests pass. Changed `\s` to `\s+` in the regex so consecutive whitespace characters are collapsed into a single dash.
  toolTrace: workspace.list_files -> workspace.read_file_raw -> workspace.read_file_raw -> workspace.patch_file -> workspace.run_command
status-label       direct       true      495   2868ms      0 src/status.js
  summary: Fix formatStatusLabel to return title-cased 'In Progress' for 'in_progress' status instead of the raw lowercase string.
status-label       mesh         true     8905  11790ms      3 src/status.js
  summary: All tests pass. The fix changes the `"in_progress"` case in `formatStatusLabel` to return `"In Progress"` instead of the raw lowercase `"in_progress"`.
  toolTrace: workspace.grep_capsules -> workspace.patch_file -> workspace.run_command

Summary: direct resolved 100.0%
Summary: mesh resolved 100.0%
Summary: direct avg tokens 635, mesh avg tokens 13156
Summary: direct avg latency 4972ms, mesh avg latency 16545ms
```