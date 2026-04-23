# mesh-agent-cli

Eigenstaendiger Terminal-Agent als MCP-Client fuer `mesh-mcp-dist`.

Flow:
1. User-Eingabe im Terminal
2. LLM-Entscheidung ueber naechsten Schritt
3. MCP Toolcall an `mesh-mcp-dist` (falls noetig)
4. Lokale Mesh-Kompression der Tool-Ergebnisse fuer den Agent-Kontext
5. Finale Antwort im Terminal

## Voraussetzungen

- Node.js 20+
- Laufender/aufrufbarer MCP-Server (`mesh-mcp-dist`) via stdio
- Entweder direkter Bedrock-Token oder zentraler Bedrock-Proxy

## Setup

```bash
cp .env.example .env
npm install
```

## Wichtige ENV Variablen

- `BEDROCK_ENDPOINT`: HTTP Endpoint fuer LLM Requests
- `AWS_BEARER_TOKEN_BEDROCK`: optional fuer direkten Bedrock-Zugriff
- `MESH_MCP_COMMAND`: Startkommando fuer MCP-Server (z. B. `node`)
- `MESH_MCP_ARGS`: JSON Array mit Args fuer das Kommando

## Empfohlener Multi-User Betrieb

Fuer mehrere Nutzer den Bedrock-Token **nicht** im CLI verteilen.
Setze stattdessen `BEDROCK_ENDPOINT` auf einen zentralen Proxy-Service:

1. CLI sendet Requests ohne lokalen Bedrock-Token.
2. Proxy haelt `AWS_BEARER_TOKEN_BEDROCK` serverseitig und setzt den Header.
3. Optional: Proxy mit User-Auth, Rate-Limits, Audit-Logs.

## Start

Interaktiv:

```bash
npm run dev
```

Einmalige Frage:

```bash
npm run dev -- "Welche Tools stehen zur Verfuegung?"
```

## Hinweis Architektur

Dieses Repo ist bewusst nur der Agent-Client.
`mesh-mcp-dist` bleibt das Tool-Backend (MCP-Server).

Zusatz:
- Das CLI hat lokale Mesh-Gateway-Kompressionslogik (`src/mesh-gateway.ts`)
  und komprimiert/glaettet grosse Tool-Payloads fuer den LLM-Kontext.
