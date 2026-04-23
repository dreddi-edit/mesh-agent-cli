```
Mesh CLI NIAH Benchmark
Model: us.anthropic.claude-opus-4-6-v1

case         mode       files needle  pass   tokens  latency details
20f-5n       direct        20      5  true     9404   3180ms included=8 inCtx=true ctxTok=7146
  response: MESH_NIAH_SECRET_20F5N_9A2F7E1C
20f-5n       mesh-cli      20      5  true     3362   4287ms tools=1
  response: MESH_NIAH_SECRET_20F5N_9A2F7E1C
  toolTrace: workspace.grep_content
20f-5n       mesh-cli-capsule    20      5 false    21545  25973ms tools=10
  error: Stopped after 10 steps without final answer.
  toolTrace: workspace.grep_capsules -> workspace.search_files -> workspace.search_files -> workspace.search_files -> workspace.search_files -> workspace.list_files! -> workspace.list_files -> workspace.grep_capsules -> workspace.list_files -> workspace.read_multiple_files
80f-60n      direct        80     60 false     9242   1848ms included=7 inCtx=false ctxTok=7040
  response: NOTFOUND
80f-60n      mesh-cli      80     60  true     3362   4644ms tools=1
  response: MESH_NIAH_SECRET_80F60N_9A2F7E1C
  toolTrace: workspace.grep_content
80f-60n      mesh-cli-capsule    80     60 false    22808  28001ms tools=10
  error: Stopped after 10 steps without final answer.
  toolTrace: workspace.grep_capsules -> workspace.search_files -> workspace.search_files -> workspace.search_files -> workspace.search_files -> workspace.list_files! -> workspace.list_files -> workspace.grep_capsules -> workspace.read_multiple_files -> workspace.read_multiple_files
180f-150n    direct       180    150 false     9242   1849ms included=7 inCtx=false ctxTok=7040
  response: NOTFOUND
180f-150n    mesh-cli     180    150  true     3362   4274ms tools=1
  response: MESH_NIAH_SECRET_180F150N_9A2F7E1C
  toolTrace: workspace.grep_content
180f-150n    mesh-cli-capsule   180    150 false    24279  27019ms tools=10
  error: Stopped after 10 steps without final answer.
  toolTrace: workspace.grep_capsules -> workspace.search_files -> workspace.search_files -> workspace.search_files -> workspace.search_files -> workspace.list_directory -> workspace.list_directory -> workspace.grep_capsules -> workspace.get_index_status -> workspace.grep_capsules

Summary: direct pass 33%, mesh-cli pass 100%, capsule-first pass 0%
Summary: direct avg tokens 9296, mesh-cli avg tokens 3362, capsule-first avg tokens 22877
Summary: direct avg latency 2292ms, mesh-cli avg latency 4402ms, capsule-first avg latency 26998ms
```