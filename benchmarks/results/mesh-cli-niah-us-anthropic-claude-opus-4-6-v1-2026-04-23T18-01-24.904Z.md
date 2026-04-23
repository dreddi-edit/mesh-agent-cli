```
Mesh CLI NIAH Benchmark
Model: us.anthropic.claude-opus-4-6-v1

case         mode       files needle  pass   tokens  latency details
20f-5n       direct        20      5  true     9404   2646ms included=8 inCtx=true ctxTok=7146
  response: MESH_NIAH_SECRET_20F5N_9A2F7E1C
20f-5n       mesh-cli      20      5  true     3362   4662ms tools=1
  response: MESH_NIAH_SECRET_20F5N_9A2F7E1C
  toolTrace: workspace.grep_content
20f-5n       mesh-cli-capsule    20      5 false     8395  17263ms tools=5
  response: The workspace appears to be empty or contains no indexed files.

NOTFOUND
  toolTrace: workspace.grep_capsules -> workspace.grep_capsules -> workspace.grep_capsules -> workspace.grep_capsules -> workspace.grep_capsules
80f-60n      direct        80     60 false     9242   2089ms included=7 inCtx=false ctxTok=7040
  response: NOTFOUND
80f-60n      mesh-cli      80     60  true     3362   5539ms tools=1
  response: MESH_NIAH_SECRET_80F60N_9A2F7E1C
  toolTrace: workspace.grep_content
80f-60n      mesh-cli-capsule    80     60 false     8395  15114ms tools=5
  response: The workspace appears to be empty or contains no indexed files.

NOTFOUND
  toolTrace: workspace.grep_capsules -> workspace.grep_capsules -> workspace.grep_capsules -> workspace.grep_capsules -> workspace.grep_capsules
180f-150n    direct       180    150 false     9242   2015ms included=7 inCtx=false ctxTok=7040
  response: NOTFOUND
180f-150n    mesh-cli     180    150  true     3362   4690ms tools=1
  response: MESH_NIAH_SECRET_180F150N_9A2F7E1C
  toolTrace: workspace.grep_content
180f-150n    mesh-cli-capsule   180    150 false     8395  17612ms tools=5
  response: The workspace appears to be empty or contains no indexed files.

NOTFOUND
  toolTrace: workspace.grep_capsules -> workspace.grep_capsules -> workspace.grep_capsules -> workspace.grep_capsules -> workspace.grep_capsules

Summary: direct pass 33%, mesh-cli pass 100%, capsule-first pass 0%
Summary: direct avg tokens 9296, mesh-cli avg tokens 3362, capsule-first avg tokens 8395
Summary: direct avg latency 2250ms, mesh-cli avg latency 4964ms, capsule-first avg latency 16663ms
```