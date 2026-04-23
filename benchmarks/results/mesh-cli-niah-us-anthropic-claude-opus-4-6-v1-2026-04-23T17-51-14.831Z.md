```
Mesh CLI NIAH Benchmark
Model: us.anthropic.claude-opus-4-6-v1

case         mode       files needle  pass   tokens  latency details
20f-5n       direct        20      5  true     9404   3003ms included=8 inCtx=true ctxTok=7146
  response: MESH_NIAH_SECRET_20F5N_9A2F7E1C
20f-5n       mesh-cli      20      5 false    14500  23274ms tools=8
  error: Stopped after 8 steps without final answer.
  toolTrace: workspace.grep_content! -> workspace.grep_content! -> workspace.grep_content! -> workspace.grep_content! -> workspace.grep_content! -> workspace.grep_content! -> workspace.grep_content! -> workspace.grep_content!
80f-60n      direct        80     60 false     9242   2247ms included=7 inCtx=false ctxTok=7040
  response: NOTFOUND
80f-60n      mesh-cli      80     60 false     8592  12851ms tools=4
  response: `MESH_NIAH_SECRET_80F60N_9A2F7E1C`
  toolTrace: workspace.grep_content! -> workspace.grep_content! -> workspace.grep_content! -> workspace.grep_content
180f-150n    direct       180    150 false     9242   2251ms included=7 inCtx=false ctxTok=7040
  response: NOTFOUND
180f-150n    mesh-cli     180    150 false    14500  22233ms tools=8
  error: Stopped after 8 steps without final answer.
  toolTrace: workspace.grep_content! -> workspace.grep_content! -> workspace.grep_content! -> workspace.grep_content! -> workspace.grep_content! -> workspace.grep_content! -> workspace.grep_content! -> workspace.grep_content!

Summary: direct pass 33%, mesh-cli pass 0%
Summary: direct avg tokens 9296, mesh-cli avg tokens 12531
Summary: direct avg latency 2500ms, mesh-cli avg latency 19453ms
```