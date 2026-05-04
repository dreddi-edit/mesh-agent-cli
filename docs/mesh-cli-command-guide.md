# Mesh CLI Command Guide

Stand: 0.3.11

Diese Datei erklärt die Slash-Commands aus `/help`, was Mesh CLI grundsätzlich kann, wie die Funktionen intern umgesetzt sind, und welche Teile noch experimentell oder nicht vollständig production-level sind.

## Kurzfassung

Mesh ist ein Terminal-Coding-Agent mit lokalem Tool-Backend, persistentem Codebase-Gedächtnis und isolierten Verifikationsumgebungen. Der Agent arbeitet nicht nur als Chat über Dateien, sondern baut lokale Artefakte in `.mesh/`, nutzt Capsules statt alles neu zu lesen, kann Patches in Timelines testen, runtime failures introspektieren und mehrere Moonshot-Workflows als produktnahe lokale Ledgers ausführen.

Der zentrale Ablauf ist:

1. `src/agent-loop.ts` nimmt User-Input und Slash-Commands entgegen.
2. `ContextAssembler` kürzt Transcript, Tools und Runtime-Kontext auf ein Budget.
3. `BedrockLlmClient` ruft das Modell über den Mesh LLM Proxy oder BYOK-Endpunkt auf.
4. `LocalToolBackend` stellt Workspace-, Runtime-, Agent- und Moonshot-Tools bereit.
5. Ergebnisse werden in `.mesh/`, Cache, Audit-Logs, Timelines oder Dashboard-Artefakten persistiert.

Code proof: `src/agent-loop.ts`, `src/context-assembler.ts`, `src/llm-client.ts`, `src/local-tools.ts`, `src/timeline-manager.ts`, `src/runtime-observer.ts`.

## Was Mesh Kann

Mesh kann heute:

- Dateien suchen, lesen, patchen, bewegen, löschen und verifizieren.
- Workspace-Capsules und einen Codebase-Index bauen, damit große Repos nicht in jedem Turn roh gelesen werden.
- Commands sicherer ausführen, mit Runtime- und Command-Safety-Guards.
- Isolierte Timelines erzeugen, Patches dort testen und erst nach Verifikation promoten.
- Runtime-Fehler mit Node/V8 Inspector Autopsy auswerten.
- Dashboard-, Voice-, Browser-Preview- und Portal-Flows starten.
- Engineering Memory, Digital Twin, Causal Intelligence, Discovery Lab, Reality Fork und Ghost Engineer Ledgers schreiben.
- Security- und Moonshot-Systeme lokal betreiben: Self-defense, Precrime, Semantic Git, Bidirectional Spec-Code, Semantic Sheriff, Tribunal, Session Resurrection.
- Audit- und Structured-Logging-Artefakte erzeugen.

Der praktische Vorteil: weniger blindes Editieren, mehr reproduzierbare Evidenz, safer promotion durch Timeline-Verifikation, persistentere Projektkenntnis und bessere Navigation in großen Repos.

## Command Reference

| Command | Was er macht | Wie es funktioniert | Code proof |
|---|---|---|---|
| `/help`, `/commands` | Zeigt die Slash-Command-Liste. | Liest die statische Command-Registry und rendert Usage/Description. | `src/agent-loop.ts#getSlashCommands`, `printHelp` |
| `/start` | Führt den First-User Golden Path aus. | Läuft Doctor, optional sichere Fixes, Index, Status und Repo-Briefing. | `src/agent-loop.ts#runStart`, `MeshDoctorEngine` |
| `/status` | Zeigt Runtime-, Session-, Modell-, Token-, Git- und Indexstatus. | Kombiniert lokale Agent-State-Daten mit Backend-Tools wie Index/Git/Sync. | `src/agent-loop.ts#printStatus`, `workspace.get_index_status`, `workspace.git_status` |
| `/capsule`, `/memory` | Verwaltet die Session Capsule. | Zeigt, komprimiert, leert oder exportiert die gespeicherte Session-Zusammenfassung. | `src/agent-loop.ts#handleCapsuleCommand`, `src/session-capsule-store.ts` |
| `/index` | Re-indexiert den Workspace. | Läuft über WorkspaceIndex und erzeugt File-Capsules plus Repo-Intelligence. | `src/agent-loop.ts#runIndexing`, `src/workspace-index.ts`, `src/cache-manager.ts` |
| `/distill` | Aktualisiert den Project Brain Context. | Analysiert Workspace-Signale und schreibt `.mesh/project-brain.md`. | `src/agent-loop.ts#distillProjectBrain` |
| `/synthesize` | Erzeugt strukturelle Change-Vorschläge. | Nutzt heuristische Repo-Signale und vorhandene Projekt-Artefakte, um nächste Änderungen vorzuschlagen. | `src/agent-loop.ts#runSynthesize` |
| `/twin` | Baut oder liest den Codebase Digital Twin. | Erzeugt strukturierte Sicht auf Dateien, Symbole, Routen und Risk-Hotspots. | `workspace.digital_twin`, `src/local-tools.ts` |
| `/repair` | Zeigt Predictive Repair Queue. | Sammelt Diagnostics und schlägt reparierbare Fehler/Tasks vor. | `workspace.predictive_repair`, `src/local-tools.ts` |
| `/daemon` | Kontrolliert den Mesh Background Daemon. | Delegiert start/status/digest/stop an das Daemon-Tool; Socket, PID und State-Dateien werden owner-only geschrieben. | `workspace.daemon`, `src/daemon.ts`, `src/daemon-protocol.ts` |
| `/issues` | Issue-to-PR Pipeline für GitHub/Linear/Jira. | Scannt Issues und erzeugt PR-orientierte Arbeitsentwürfe. | `workspace.issue_pipeline`, `src/integrations/issues/*` |
| `/change` | Führt eine kleine, verifizierte Codeänderung aus. | Scopet wahrscheinliche Dateien, instruiert den Agent auf minimalen Patch und führt erkannte Verification aus. | `src/agent-loop.ts#runChange`, `workspace.ask_codebase` |
| `/chatops` | Slack/Discord Co-Engineer Flow. | Nimmt ChatOps-Kontext, erstellt Investigation/Approval-Status und PR-Draft. | `workspace.chatops`, `src/integrations/chatops/manager.ts` |
| `/production` | Zeigt Produktionssignale und Top-Regressions. | Liest/refreshes `.mesh/production-signals.json` aus Telemetry-Connectors. | `workspace.production_status`, `src/integrations/telemetry/*` |
| `/replay` | Replay einer Production Trace. | Rekonstruiert Trace/Sentry Event und prüft Divergenz über Timeline/Runtime-Daten. | `runtime.replay_trace`, `src/runtime/replay.ts` |
| `/bisect` | Automatisches Git-Bisect nach Symptom. | Testet Commits mit Verification Command und meldet wahrscheinlichen Einführungscommit. | `workspace.symptom_bisect`, `src/timeline/symptom-bisect.ts` |
| `/whatif` | Counterfactual Migration Analyse. | Erstellt eine isolierte Timeline, simuliert Änderungshypothese und bewertet Auswirkungen. | `workspace.what_if`, `src/local-tools.ts#whatIf` |
| `/audit` | Audit-Log replay/verify. | Prüft Hash-Chain-Integrität der Tool-Calls in `.mesh/audit`. | `workspace.audit`, `src/audit/logger.ts` |
| `/brain` | Mesh Brain Stats/Query/Opt-out. | Fragt globale Fix-Pattern oder lokalen Contribution-Status ab. | `workspace.brain`, `src/mesh-brain.ts` |
| `/learn` | Engineering Memory lesen oder aktualisieren. | Extrahiert Repo-Gewohnheiten, Risk-Module und Regeln aus lokaler Historie. | `workspace.engineering_memory`, `src/local-tools.ts` |
| `/intent` | Product Intent zu Implementierungscontract. | Mappt freie Produktabsicht auf wahrscheinliche Dateien, Risiken, Phasen und Verification. | `workspace.intent_compile`, `src/local-tools.ts#intentCompile` |
| `/causal` | Causal Software Intelligence. | Baut oder queried einen Graph aus Files, Risiken, Tests und Ursachenketten. | `workspace.causal_intelligence`, `src/local-tools.ts` |
| `/lab` | Autonomous Discovery Lab. | Sammelt Hypothesen und Discovery-Items aus Causal/Repair/Workspace-Signalen. | `workspace.discovery_lab`, `src/local-tools.ts` |
| `/fork` | Reality Forks planen oder materialisieren. | Erstellt alternative Implementierungsrealitäten in Timelines und bewertet sie. | `workspace.reality_fork`, `src/local-tools.ts#realityFork` |
| `/ghost` | Ghost Engineer Style-Replay. | Lernt lokalen Engineering-Stil, sagt Implementierungspfade voraus und erzeugt Timeline-Patches. | `workspace.ghost_engineer`, `src/local-tools.ts#ghostEngineer` |
| `/fix` | Background-resolved Fix anwenden. | Nutzt gespeicherte speculative fixes für aktuelle Linter/Compiler-Probleme. | `src/agent-loop.ts#runFix` |
| `/hologram` | Command mit V8 Telemetry starten. | Injiziert Runtime Observer/Autopsy Hook via Node Options und speichert Run-Artefakte. | `runtime.start`, `src/runtime-observer.ts` |
| `/entangle` | Zweites Repo quantum-linken. | Verknüpft Repository-Pfade für experimentelle AST-/Sync-Workflows. | `src/agent-loop.ts#runEntangle` |
| `/inspect` | Visual Agent Portal attachen. | Startet/attacht Browser-Portal und Overlay für UI/Canvas-Inspection. | `src/mesh-portal.ts`, `src/agent-loop.ts#handleInspect` |
| `/stop-inspect` | Visual Portal detach. | Entfernt Browser-Overlay und beendet Portal-Verbindung. | `src/agent-loop.ts#handleSlashCommand`, `MeshPortal.stop` |
| `/preview` | Frontend Screenshot im Terminal. | Nutzt Chrome/CDP Preview mit optionalen Ausgabeprotokollen. | `frontend.preview`, `src/terminal-preview.ts` |
| `/dashboard` | Lokales 3D/Interactive Dashboard starten. | Startet `dashboard-server.js`, schreibt Events nach `.mesh/dashboard`, öffnet lokale URL mit API-Token im Fragment statt im HTML. | `src/dashboard-server.ts`, `src/agent-loop.ts#launchDashboard` |
| `/sync` | L2 Cache Sync Status. | Fragt Cloud/Supabase Cache-Zustand und lokale L1/L2-Statistiken ab. | `workspace.check_sync`, `src/cache-manager.ts` |
| `/setup` | Interaktive oder scripted Settings. | Speichert Modell, Theme, Cloud, Key, Endpoint und Voice-Konfig in User Settings. | `src/config.ts`, `src/agent-loop.ts#handleSetupCommand` |
| `/model` | Modell wählen/listen/speichern. | Nutzt den zentralen Model Catalog und aktualisiert Current/User Model. | `src/model-catalog.ts`, `src/agent-loop.ts#handleModelCommand` |
| `/cost` | Tokenverbrauch und Kosten anzeigen. | Rechnet Session Input/Output Tokens gegen Model Pricing. | `src/agent-loop.ts#printCost` |
| `/approvals` | Tool Auto-Approval steuern. | Schaltet Approval-Policy für risky Tools im aktuellen Agent-Kontext. | `src/agent-loop.ts#handleApprovalsCommand` |
| `/undo` | Letzte Agent-Dateiänderung revertieren. | Delegiert an `workspace.undo` und nutzt lokale Backup/Undo-Mechanik. | `workspace.undo`, `src/local-tools.ts` |
| `/steps` | Max Tool Steps setzen. | Ändert `maxSteps` für die aktuelle Session. | `src/agent-loop.ts#handleStepsCommand` |
| `/doctor` | Runtime-Diagnose. | Prüft Umgebung, Voice-Deps, Modellpfade, Tooling und optional Fixes. | `src/agent-loop.ts#runDoctor`, `src/voice-manager.ts` |
| `/compact` | Transcript komprimieren. | Verdichtet Chat/Tool-Historie in Session Capsule. | `src/agent-loop.ts#compactTranscript` |
| `/clear` | Terminal UI leeren. | ANSI clear plus Banner-Reprint. | `src/agent-loop.ts#handleSlashCommand` |
| `/voice` | Speech-to-Speech konfigurieren/aktivieren. | Nutzt Whisper/ffmpeg für STT und lokale/system TTS-Stimmen. | `src/voice-manager.ts`, `src/agent-loop.ts#runVoiceSetupWizard` |
| `/exit`, `/quit` | CLI beenden. | Signalisiert dem Main-Loop `shouldExit`. | `src/agent-loop.ts#handleSlashCommand` |
| `/tribunal` | 3-Panel AI Tribunal. | Lässt Correctness, Performance und Resilience Panelists debattieren und schreibt Entscheidungsartefakt. | `workspace.tribunal`, `src/moonshots/tribunal.ts` |
| `/resurrect` | Session State speichern/wiederherstellen. | Persistiert Intent, offene Fragen, Checkpoints und Next Actions. | `workspace.session_resurrection`, `src/moonshots/session-resurrection.ts` |
| `/sheriff` | Semantic Contract Sheriff. | Fingerprintet Modulsemantik, locked Contracts und meldet Drift. | `workspace.semantic_sheriff`, `src/moonshots/semantic-sheriff.ts` |

## Weitere Wichtige Tool-Funktionen Ohne Eigenen Slash-Command

Diese Funktionen werden vom Agent automatisch genutzt oder sind über Tool-Calls erreichbar:

| Tool | Zweck | Code proof |
|---|---|---|
| `workspace.self_defend` | Security-Probing, ReDoS-Hardening in Timelines, Security-Ledger. | `src/security/self-defending.ts` |
| `workspace.precrime` | 14-Tage-Risiko-Gates aus lokalen Outcomes, Telemetry und globalen Patterns. | `src/moonshots/precrime.ts` |
| `workspace.semantic_git` | Semantic merge analyze/plan/resolve/verify mit Timeline-Gate. | `src/moonshots/semantic-git.ts` |
| `workspace.spec_code` | Bidirectional Spec-Code Contracts, Drift, Materialization Plans. | `src/moonshots/spec-code.ts` |
| `workspace.natural_language_source` | Natürlichsprachige Intent-Spezifikation zu Implementation IR. | `src/moonshots/natural-language-source.ts` |
| `workspace.fluid_mesh` | Capability Map über Scripts, Routes und reusable Funktionen. | `src/moonshots/fluid-mesh.ts` |
| `workspace.living_software` | Aggregierter Pulse über Moonshot-Ledgers und Self-Maintenance-Signale. | `src/moonshots/living-software.ts` |
| `workspace.proof_carrying_change` | Promotion Proof Bundle mit Risiken, Contracts, Verification und Rollback. | `src/moonshots/proof-carrying-change.ts` |
| `workspace.causal_autopsy` | Failure-Ursachenanalyse aus Runtime, Proof, Precrime, Self-defense und Graph-Signalen. | `src/moonshots/causal-autopsy.ts` |
| `workspace.timeline_*` | Timelines erzeugen, patchen, verifizieren, vergleichen, promoten. | `src/timeline-manager.ts` |
| `runtime.*` | Runtime start/capture/explain/fix/replay. | `src/runtime-observer.ts`, `src/runtime/replay.ts` |
| `agent.*` | Race fixes, spawn/review/merge_verified, planning. | `src/local-tools.ts` |

## Wie Die Architektur Zusammenarbeitet

### Context und Capsules

Mesh vermeidet, große Tool-Ausgaben roh ins Modell zu kippen. File-Capsules, Batch-L1/L2-Cache und ContextAssembler halten Kontext klein und gezielt.

Code proof: `src/cache-manager.ts#getCapsuleBatch`, `src/context-assembler.ts`, `src/workspace-index.ts`.

### Safety und Validation

Tool-Inputs werden zentral gegen JSON-Schema validiert. Destruktive Commands werden durch Pattern-Guards blockiert. Runtime `NODE_OPTIONS` wird allowlisted.

Code proof: `src/tool-schema.ts`, `src/command-safety.ts`, `src/runtime-observer.ts#mergeNodeOptions`.

### Timelines

Riskante Änderungen können in isolierten Worktrees oder Copy-Fallbacks getestet werden. Promotion ist getrennt von Patch-Erzeugung.

Code proof: `src/timeline-manager.ts#create`, `run`, `compare`, `promote`.

### Runtime Observer

Node-Commands können mit Autopsy Hook laufen. Bei Exceptions werden Stackframes, Scope-Infos und Fallback-Logs persistiert.

Code proof: `src/runtime-observer.ts#buildAutopsyHookSource`, `captureDeepAutopsy`.

### Dashboard und Portal

Der Agent schreibt Dashboard-Events nach `.mesh/dashboard` und startet einen lokalen Server. `/inspect` kann Browser-Overlay/Portal verbinden. Dashboard-API-Aufrufe benötigen einen pro Prozess erzeugten Token; `/dashboard` übergibt ihn per URL-Fragment und entfernt ihn nach dem Laden aus der sichtbaren URL.

Code proof: `src/dashboard-server.ts`, `src/mesh-portal.ts`, `src/agent-loop.ts#appendDashboardEvent`.

### Moonshot Ledgers

Viele neue Features sind lokale, nachvollziehbare Ledgers in `.mesh/`. Das ist bewusst: erst persistente Evidenz, dann Automatisierung.

Beispiele:

- `.mesh/security/*` für self-defense.
- `.mesh/precrime/*` für Future-Self-Modell.
- `.mesh/spec-code/*` für bidirectional contracts.
- `.mesh/semantic-git/*` für merge plans/resolutions.
- `.mesh/semantic-contracts/*` für Sheriff.
- `.mesh/tribunal/latest.json` für Tribunal-Entscheidungen.

## Vorteile In Der Nutzung

- **Weniger Kontextverschwendung:** Capsules und Kontextbudgets sparen Tokens.
- **Bessere Sicherheit:** Command-Guards, Input-Validation, sensitive path policies und Timeline-Gates verhindern viele riskante Aktionen.
- **Bessere Reviewbarkeit:** Viele Tools schreiben Ledgers statt nur Chat-Antworten.
- **Schnelleres Debugging:** Runtime Autopsy, Replay, Bisect und Causal Autopsy verkürzen die Suche nach Root Causes.
- **Mehr Autonomie ohne Blindflug:** Race fixes, Reality Forks und Semantic Git arbeiten in isolierten Timelines.
- **Langfristiges Projektgedächtnis:** Engineering Memory, Ghost Engineer, Session Resurrection und Project Brain verhindern, dass Wissen nur im Transcript lebt.

## Reifegrad Und Grenzen

### Solide / produktionsnah

- File read/search/patch/write basics.
- Tool schema validation.
- Command safety blacklist.
- Capsule Cache L1 und Batch-Fetch.
- Timeline create/run/compare/promote inklusive copy fallback.
- Runtime Observer mit Node/V8 Autopsy.
- Audit Hash Chain.
- Model catalog und fallback handling.
- `spec_code`, `semantic_git`, `self_defend`, `precrime` als lokale, testgedeckte Ledgers/Workflows.

### Produktiv nutzbar, aber konservativ behandeln

- `/dashboard`: nützlich als Supervision UI, aber visuelle/3D-Darstellung ist eher Cockpit als harte Verification.
- `/voice`: abhängig von lokaler Plattform, ffmpeg, whisper-cpp und Model-Downloads.
- `/issues`, `/chatops`, `/production`: Qualität hängt von korrekt konfigurierten Integrationen und Datenquellen ab.
- `/brain`: globaler Nutzen hängt von Endpoint, Opt-in und realem Pattern-Korpus ab.
- `/tribunal`: strukturiertes Decision-Support-System, kein formaler Beweis.
- `/sheriff`: erkennt semantische Drift über Fingerprints/Signaturen, ersetzt keine vollständige Testsuite.

### Noch experimentell / nicht 100% production-perfect

- **Self-defending code:** Aktuell ist Auto-Patching deterministisch nur für einfache ReDoS-Patterns produktionsnah. SQLi, path traversal und command injection werden bestätigt und gemeldet, aber nicht vollautomatisch perfekt gepatcht.
- **Precrime:** Lokales Future-Self-Modell ist regel-/outcome-basiert. Ein echtes global trainiertes Modell über 50k Codebases existiert in dieser Codebasis noch nicht vollständig.
- **Semantic Git:** Löst Konflikte mit distinct symbols gut, blockt sensible oder überlappende Konflikte. Voll semantisches branchless Git ist noch Forschungs-/Ausbaugebiet.
- **Bidirectional Spec-Code:** Contracts, Drift, Locks und Materialization-Pläne existieren. Vollständige Codegenerierung aus beliebigen Specs ist absichtlich nicht automatisch.
- **Natural language as source:** Compile-to-IR ist vorhanden; vollständige natürliche Sprache als primäre Source of Truth ist noch nicht erreicht.
- **Fluid Mesh / Living Software:** Capability Map und Pulse existieren, aber Repository-übergreifende Governance/IP/Runtime-Migration ist noch offen.
- **Ephemeral Execution:** Zero-source/JIT execution ist ein Endgame-Experiment, nicht für kritische Produktion freigegeben.
- **Schrodinger AST / Entangle:** Stark experimentelle Workflows; nur mit isolierter Verification verwenden.

## Empfehlung Für Den Alltag

Für normale Arbeit:

1. `/status`
2. `/index`
3. `/intent <ziel>`
4. normal mit Mesh arbeiten
5. vor riskanten Änderungen `/fork`, `/whatif`, `workspace.timeline_*` oder `/ghost patch`
6. vor Abschluss `npm test`, `npm run typecheck`, `workspace.proof_carrying_change`

Für Qualitäts-/Sicherheitsarbeit:

1. `workspace.spec_code action=synthesize`
2. `workspace.self_defend action=probe`
3. `workspace.precrime action=gate`
4. `/sheriff scan`, dann `/sheriff verify`
5. `/causal build` oder `/lab run`

Für Merge-/Conflict-Arbeit:

1. `workspace.semantic_git action=analyze`
2. `workspace.semantic_git action=plan`
3. `workspace.semantic_git action=resolve verificationCommand="npm test"`
4. erst danach optional mit `promote=true` oder manuell reviewen.

## Wichtig

Mesh ist am stärksten, wenn du es als Arbeits- und Evidenzsystem nutzt, nicht nur als Chat. Die besten Resultate entstehen, wenn Änderungen über Timelines, Tests, Contracts, Proofs und lokale Ledgers laufen. Die Moonshot-Features sind inzwischen mehr als Demos, aber sie sollten bei produktionskritischem Code weiterhin konservativ mit Verification und Review eingesetzt werden.
