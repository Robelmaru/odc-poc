# Instructions for AI assistants

This folder is a Kustomize deployment: `base/` holds the Deployment/Service and
`overlays/<environment>/` holds the per-environment configuration. Follow these
rules whenever you modify it.

## Secrets policy (MANDATORY)

All application secrets are delivered through **Azure Key Vault** via the
Secrets Store CSI driver. Secrets must NEVER be hardcoded in manifests,
ConfigMaps, environment variables, or plain Kubernetes `Secret` objects
committed to Git.

When asked to add, move, or manage a secret for this app:

1. **Move it into each overlay's `overlays/<environment>/secretproviderclass.yaml`**
   by appending an entry to the `objects:` array. Every entry MUST be preceded by
   a `#` comment stating what the secret is used for (which component reads it
   and why), so the file stays self-documenting:

   ```yaml
   # <what this secret is for, e.g. "billing database connection string, read by the API at startup">
   - |
     objectName: <secret-name>
     objectType: secret
   ```

   When moving an existing secret, carry over (or write) its purpose comment;
   if an entry has no comment, add one based on how the app uses it.

2. Each environment has its **own Key Vault** - use the `keyvaultName` already
   present in that overlay's `secretproviderclass.yaml`. Never point two
   environments at the same vault.

3. Store the actual value in Azure Key Vault, never in Git:

   ```sh
   az keyvault secret set --vault-name <keyvaultName> --name <secret-name> --value '<value>'
   ```

4. The CSI volume declared in `deployment-patch.yaml` mounts the secrets
   read-only at `/mnt/secrets/<objectName>` in the pod. Have the application
   read them from those files.

5. If you find a secret value hardcoded anywhere in these manifests (or are
   given one to add), move it to Key Vault + the SecretProviderClass as above
   and remove the plaintext.

6. After ANY change that adds, renames, or removes a secret - and whenever you
   are asked what secrets this deployment needs - OUTPUT a hand-off block,
   headed exactly "Send to Infrastructure Team", listing every secret name that
   must exist in each environment's Azure Key Vault. Read the `objects:` array
   from every overlay's `secretproviderclass.yaml` (the vault name is the
   `keyvaultName` in the same file) and present it like:

   ```
   ==== Send to Infrastructure Team ====
   Key Vault secrets required:
   - <dev vault>:     secret-one, secret-two
   - <staging vault>: secret-one, secret-two
   - <prod vault>:    secret-one, secret-two

   To create any that are missing:
   az keyvault secret set --vault-name <vault> --name <secret-name> --value '<value>'
   =====================================
   ```

   The deployment cannot start correctly until every listed secret exists in
   its vault - never leave this list implicit.

### This deployment's secrets

Every overlay's `secretproviderclass.yaml` carries the same four secrets (the
values differ per environment - each has its own vault):

| Key Vault object | App variable | Read by |
|------------------|--------------|---------|
| `database-url` | `DATABASE_URL` | API at startup + the Drizzle migration run |
| `anthropic-api-key` | `ANTHROPIC_API_KEY` | analysis, Q&A, timeline, translation, AI-detect fallback |
| `gptzero-api-key` | `GPTZERO_API_KEY` | `/api/ai-detect` (falls back to Claude when absent) |
| `entra-client-secret` | `ENTRA_CLIENT_SECRET` | `/auth` OAuth code exchange (staff SSO) |

Non-secret configuration is NOT a Key Vault concern - keep `ENTRA_CLIENT_ID`,
`ENTRA_TENANT_ID`, `ENTRA_REDIRECT_URI`, `ENTRA_ALLOWED_DOMAINS`, `CORS_ORIGINS`,
`UPLOAD_MAX_MB`, `MAX_PDF_PAGES`, `RULE_ANALYSIS_ENABLED` and the OCR tuning vars
as plain `env:` entries or a ConfigMap. The legacy `PIN_*` staff PINs appear in
`backend/.env.example` but no code reads them - do not add them to a vault.

**Open item:** the app reads these four values from environment variables
(`backend/src/loadEnv.ts` / `--env-file`), while the CSI driver delivers them as
files under `/mnt/secrets/<objectName>`. Until the app reads those files (or the
SecretProviderClass syncs them via `secretObjects`), the mounted secrets are not
actually consumed. Do not paper over this with a committed `Secret`.

Do not add `Secret` manifests to this folder. The ingress TLS secret referenced
by each overlay is created manually on the cluster with `kubectl create secret
tls` (see the README's Cluster setup section) - never commit TLS certificates
or private keys.

## Image tags (MANDATORY)

Container images MUST use **immutable tags in the form of a Git commit SHA**
(e.g. `sha-abc1234`) - never `latest` or any other mutable tag.

- To deploy a new version, change `images: ... newTag:` in each overlay's
  `kustomization.yaml` to the new commit's SHA tag (or let the ArgoCD Image
  Updater bump it). Never retag or re-push an existing tag.
- If you find a `latest` (or otherwise mutable) tag in these manifests, replace
  it with the current build's SHA tag.

## Storage (MANDATORY)

Any `PersistentVolumeClaim` or `volumeClaimTemplate` added to this deployment
MUST set `storageClassName` explicitly, naming the intended class - never omit
it to silently fall back on the cluster's default StorageClass.

## ArgoCD hooks and sync waves (MANDATORY)

Any resource consumed by an ArgoCD hook (a PreSync/PostSync `Job`, etc.) MUST
be created before the hook runs - e.g. a ConfigMap, Secret, ServiceAccount, or
PVC that a hook Job reads or mounts. BOTH annotations are required on the
consumed resource:

```yaml
metadata:
  annotations:
    argocd.argoproj.io/hook: PreSync     # same phase as the hook that uses it
    argocd.argoproj.io/sync-wave: "-1"   # lower wave than the hook, so it exists first
```

The hook phase annotation is needed because plain resources are created in the
Sync phase, which runs AFTER PreSync hooks - a lower sync-wave alone does not
help across phases. The lower sync-wave then orders it before the hook within
that phase.

Never assume hooks and regular resources sync in the order they are declared in
Git - ArgoCD orders resources by phase, then sync-wave, then kind, and file or
manifest order plays no part. If a hook depends on a resource, express that
dependency explicitly with both annotations above.

## Security contexts (MANDATORY)

Any `securityContext` that sets `runAsNonRoot: true` MUST also set a numeric
`runAsUser` that matches the image's ACTUAL user ID:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1001   # must be the UID the image really runs as - verified, not guessed
```

Kubernetes cannot validate `runAsNonRoot` against a named (non-numeric) user,
and a wrong UID breaks file ownership/permissions inside the container. Look
the UID up from the image rather than assuming one:

- check the image's Dockerfile for its `USER` directive / the user it creates, or
- run the image and ask it: `docker run --rm --entrypoint id <image>`
  (or `id <user>` inside the container)

Never guess common values like `1000` or `65534` - verify against the image.
### This deployment's persistent storage

Persistent data lives on these PersistentVolumeClaims, mounted at `/data` in the pod:

- **development**: PVC ``doc-analyzer-dev-storage`` - 1Gi, StorageClass ``nfs-dynamic``, ReadWriteMany
- **staging**: PVC ``doc-analyzer-staging-storage`` - 1Gi, StorageClass ``nfs-dynamic``, ReadWriteMany
- **production**: PVC ``doc-analyzer-production-storage`` - 1Gi, StorageClass ``nfs-dynamic``, ReadWriteMany

When the application needs to persist data, write it under `/data` (the volume
above) - do NOT add emptyDir/hostPath volumes or create additional PVCs for persistent
data. If asked to add storage to another environment, follow the same conventions:
name it `<app>-<envshort>-storage`, add the `env` label, use ReadWriteMany, and set
`storageClassName` explicitly (see pvc.yaml in an existing overlay).

## Application health (MANDATORY)

This app (`odc-poc`, a Fastify backend) serves two health endpoints, and the
Deployment's probes are split across them deliberately - there is no `/healthz`:

| Probe | Path | Why |
|-------|------|-----|
| readiness | `/api/health` | pings Postgres and reports dependency status, so a pod with a broken DB is pulled from the Service (not killed) |
| liveness | `/api/health/live` | process-only, no dependencies - OCR/multi-pass Claude work must not get the pod restarted mid-upload |

`/api/health/crashes` reports recent uncaught exceptions, persisted across the
restart that follows - use it to diagnose a crash without pod-log access.

Monitor and protect these endpoints:

- The application MUST answer both with HTTP 200 whenever it is healthy (`/api/health`
  returns a non-200 when a dependency check fails - that is intentional and gates
  readiness only). Never remove or rename them - Kubernetes restarts the pod
  (liveness) and withholds traffic (readiness) when they fail.
- When changing the app or manifests, keep the endpoints and both probes in
  `base/deployment.yaml` in sync; if a health path moves in
  `backend/src/index.ts`, update the matching probe (and the Dockerfile
  `HEALTHCHECK`, which also hits `/api/health`).
- When monitoring or debugging this deployment, start with the health endpoint:
  `kubectl -n <namespace> get pods` (look for NotReady / CrashLoopBackOff),
  `kubectl -n <namespace> describe pod <pod>` (probe failures appear as Unhealthy
  events), and `kubectl -n <namespace> logs deploy/<app>` for the cause. After any
  deploy or config change, verify `/api/health` returns 200 before considering the
  change done.
- When checking health manually or in scripts (`kubectl exec`, the Dockerfile
  `HEALTHCHECK`, smoke tests), use `127.0.0.1` explicitly:
  `curl http://127.0.0.1:3000/api/health` - not `localhost`, which can
  resolve to the IPv6 `::1` the app may not be listening on, producing false
  failures. The application itself must listen on all interfaces (`0.0.0.0`) so it
  is reachable both via `127.0.0.1` and via the pod IP the kubelet probes.
- Keep `/api/health/live` fast and dependency-free (no database or external calls), so
  liveness failures indicate real application trouble rather than downstream noise.
  Dependency checks belong in `/api/health`, which only gates readiness.