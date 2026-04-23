# mesh-agent-cli

Eigenstaendiger Terminal-Agent als MCP-Client oder Local-Agent fuer Mesh.

Flow:
1. User-Eingabe im Terminal
2. LLM-Entscheidung ueber naechsten Schritt
3. Toolcall an lokales Tool-Backend (`local`) oder `mesh-mcp-dist` (`mcp`)
4. Lokale Mesh-Kompression der Tool-Ergebnisse fuer den Agent-Kontext
5. Finale Antwort im Terminal

## Modi

- `local` (Default): Kein Server noetig, lokale Workspace-Tools im Prozess.
- `mcp`: Nutzt `mesh-mcp-dist` als MCP-Tool-Backend via stdio.

## Voraussetzungen

- Node.js 20+
- Bedrock Endpoint (direkt oder ueber Proxy)
- Optional fuer `mcp`-Mode: aufrufbarer `mesh-mcp-dist` Prozess

## Setup

```bash
cp .env.example .env
npm install
```

## Wichtige ENV Variablen

- `BEDROCK_ENDPOINT`: HTTP Endpoint fuer LLM Requests
- `AWS_BEARER_TOKEN_BEDROCK`: optional fuer direkten Bedrock-Zugriff
- `AGENT_MODE`: `local` oder `mcp` (default `local`)
- `WORKSPACE_ROOT`: Root fuer lokale Datei-Tools in `local`-Mode
- `MESH_MCP_COMMAND`: Startkommando fuer MCP-Server (nur `mcp`-Mode)
- `MESH_MCP_ARGS`: JSON Array mit Args fuer das MCP-Kommando

## Start

Interaktiv:

```bash
npm run dev
```

Einmalige Frage:

```bash
npm run dev -- "Welche Tools stehen zur Verfuegung?"
```

## Mesh-Core Integration

Wenn `./mesh-core` vorhanden ist, nutzt `local`-Mode direkt Teile der Mesh-Core-Logik
(z. B. File-Type-Erkennung, Token-Schaetzung, Capsule-Vorschau). Ohne `mesh-core`
laeuft das CLI mit sauberem Fallback weiter.

## npm Release Automation

- Paketname: `@dreddi-edit/mesh-agent-cli`
- Binary: `mesh-agent`
- Bei jedem Push auf `main`:
  1. Build
  2. Laufzeit-Version aus GitHub-Run-Nummer
  3. `npm publish`
