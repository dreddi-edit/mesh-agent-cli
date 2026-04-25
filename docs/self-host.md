# Mesh Self-Hosted Control Plane

This deployment mode is intended for regulated environments that require private infrastructure.

## Components

- Mesh CLI + daemon runtime
- Mesh Brain service (private federation by default)
- Postgres (state and metadata)
- MinIO (object storage for logs/artifacts)
- Audit trail JSONL chain in `.mesh/audit/`

## Quickstart (single VM)

1. Set required environment values:
   - `MESH_LICENSE_KEY` (offline signed key)
   - `BEDROCK_ENDPOINT` (or internal model gateway endpoint)
2. Start stack:
   - `docker compose up -d`
3. Verify:
   - `mesh daemon status`
   - `mesh /audit verify`

## Kubernetes

Use the Helm chart in `helm/`:

```bash
helm install mesh ./helm --set license.key="$MESH_LICENSE_KEY"
```

## Federation model

- Default: private Mesh Brain only
- Optional: privacy-preserved federation by forwarding anonymized signatures to public Brain endpoint

## Compliance controls

- Tamper-evident hash-chain audit logs
- Daily rotating JSONL files in `.mesh/audit/`
- Keychain-first secret handling for integrations
