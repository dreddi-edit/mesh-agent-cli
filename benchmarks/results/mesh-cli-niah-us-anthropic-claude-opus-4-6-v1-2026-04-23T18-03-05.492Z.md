```
Mesh CLI NIAH Benchmark
Model: us.anthropic.claude-opus-4-6-v1

case         mode       files needle  pass   tokens  latency details
20f-5n       direct        20      5  true     9404   2940ms included=8 inCtx=true ctxTok=7146
  response: MESH_NIAH_SECRET_20F5N_9A2F7E1C
20f-5n       mesh-cli      20      5  true     3362   5456ms tools=1
  response: MESH_NIAH_SECRET_20F5N_9A2F7E1C
  toolTrace: workspace.grep_content
20f-5n       mesh-cli-capsule    20      5  true     2366   5238ms tools=1
  response: MESH_NIAH_SECRET_20F5N_9A2F7E1C
  toolTrace: workspace.grep_capsules
80f-60n      direct        80     60 false     9242   2801ms included=7 inCtx=false ctxTok=7040
  response: NOTFOUND
80f-60n      mesh-cli      80     60  true     3362   5001ms tools=1
  response: MESH_NIAH_SECRET_80F60N_9A2F7E1C
  toolTrace: workspace.grep_content
80f-60n      mesh-cli-capsule    80     60  true     2366   7630ms tools=1
  response: MESH_NIAH_SECRET_80F60N_9A2F7E1C
  toolTrace: workspace.grep_capsules
180f-150n    direct       180    150 false     9242   1951ms included=7 inCtx=false ctxTok=7040
  response: NOTFOUND
180f-150n    mesh-cli     180    150  true     3362   4951ms tools=1
  response: MESH_NIAH_SECRET_180F150N_9A2F7E1C
  toolTrace: workspace.grep_content
180f-150n    mesh-cli-capsule   180    150  true     2365   4935ms tools=1
  response: MESH_NIAH_SECRET_180F150N_9A2F7E1C
  toolTrace: workspace.grep_capsules

Summary: direct pass 33%, mesh-cli pass 100%, capsule-first pass 100%
Summary: direct avg tokens 9296, mesh-cli avg tokens 3362, capsule-first avg tokens 2366
Summary: direct avg latency 2564ms, mesh-cli avg latency 5136ms, capsule-first avg latency 5934ms
```