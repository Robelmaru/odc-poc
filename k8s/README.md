# doc-analyzer - Kubernetes deployment

Kustomize deployment scaffolded by `New-K8sDeployment.ps1` on 2026-08-05 14:44,
then adapted to this repo's app (`odc-poc`) on 2026-08-05.
This file documents the custom configuration used to generate the manifests in this folder.

> **Note - two deployment trees live in this repo.** `deploy/k8s/` is the tree the
> Argo CD Applications in [argocd/](../argocd) currently point at (app name `odc-poc`,
> plain `odc-poc-secrets` Kubernetes Secret, PreSync migration Job). This `k8s/`
> tree is the newer scaffold: app name `doc-analyzer`, secrets from Azure Key Vault
> via the CSI driver, per-environment PVCs. Nothing points Argo CD at `k8s/` yet -
> pick one tree before deploying, and see "Not yet carried over" below.

## Application

| Setting | Value |
|---------|-------|
| App name | `doc-analyzer` |
| Image | `ghcr.io/dc-bar-web/odc-poc:sha-7bc8882` |
| Container port | 3000 |
| Service port | 80 |
| Health check paths | `/api/health` (readiness, pings Postgres), `/api/health/live` (liveness, dependency-free) |
| Image pull secret | `ghcr-pull-secret` |
| Base domain | `dcbar.org` |
| Key Vault secrets | Enabled |

## Overlays

| Environment | Namespace | Ingress host | TLS secret | Replicas |
|-------------|-----------|--------------|------------|----------|
| development | `doc-analyzer-dev` | `dev-doc-analyzer.dcbar.org` | `dev-doc-analyzer` | 2 |
| staging | `doc-analyzer-staging` | `staging-doc-analyzer.dcbar.org` | `staging-doc-analyzer` | 2 |
| production | `doc-analyzer-production` | `doc-analyzer.dcbar.org` | `production-doc-analyzer` | 3 |

### Azure Key Vault (per environment)

Each overlay has its own SecretProviderClass named after its Key Vault; the CSI volume is
mounted at `/mnt/secrets`.

| Environment | Key Vault | Tenant id |
|-------------|-----------|-----------|
| development | `dcbar-docanalyzer-dev-kv` | `89df4ea7-2a11-4867-8a15-e2e6102deb04` |
| staging | `dcbar-docanalyzer-stg-kv` | `89df4ea7-2a11-4867-8a15-e2e6102deb04` |
| production | `dcbar-docanalyze-prod-kv` | `89df4ea7-2a11-4867-8a15-e2e6102deb04` |

All three vaults hold the same four secret names (different values per environment):

| Key Vault object | App variable | Read by |
|------------------|--------------|---------|
| `database-url` | `DATABASE_URL` | API at startup + the Drizzle migration run |
| `anthropic-api-key` | `ANTHROPIC_API_KEY` | analysis, Q&A, timeline, translation, AI-detect fallback |
| `gptzero-api-key` | `GPTZERO_API_KEY` | `/api/ai-detect` (falls back to Claude when absent) |
| `entra-client-secret` | `ENTRA_CLIENT_SECRET` | `/auth` OAuth code exchange (staff SSO) |

Non-secret settings (`ENTRA_CLIENT_ID`, `ENTRA_TENANT_ID`, `ENTRA_REDIRECT_URI`,
`ENTRA_ALLOWED_DOMAINS`, `CORS_ORIGINS`, `UPLOAD_MAX_MB`, `MAX_PDF_PAGES`,
`RULE_ANALYSIS_ENABLED`, OCR tuning) belong in the Deployment's `env:` - not in a vault.

### Persistent storage (per environment)

Each overlay has its own uniquely-named PersistentVolumeClaim, mounted at `/data`
with an explicitly-named StorageClass.

| Environment | PVC / volume name | Size | Storage class |
|-------------|-------------------|------|---------------|
| development | `doc-analyzer-dev-storage` | 1Gi | `nfs-dynamic` |
| staging | `doc-analyzer-staging-storage` | 1Gi | `nfs-dynamic` |
| production | `doc-analyzer-production-storage` | 1Gi | `nfs-dynamic` |

## Structure

```
k8s/
  README.md
  setup.ps1  (runnable script for all the Azure + cluster setup commands below)
  AGENTS.md  (secrets-handling rules for AI assistants)
  base/  (deployment.yaml, service.yaml, kustomization.yaml)
  overlays/
    development/  (ingress.yaml, kustomization.yaml, deployment-patch.yaml, secretproviderclass.yaml, pvc.yaml)
    staging/  (ingress.yaml, kustomization.yaml, deployment-patch.yaml, secretproviderclass.yaml, pvc.yaml)
    production/  (ingress.yaml, kustomization.yaml, deployment-patch.yaml, secretproviderclass.yaml, pvc.yaml)
```

## Not yet carried over from `deploy/k8s/`

This tree is not a drop-in replacement yet. Before pointing Argo CD at it:

- **Secret delivery.** The CSI driver mounts the four vault secrets as files under
  `/mnt/secrets/`, but the app reads environment variables. Either teach the backend
  to read `/mnt/secrets/<name>` or add `secretObjects:` to each SecretProviderClass
  so the driver syncs them into an env-consumable Secret.
- **Database migrations.** `deploy/k8s/base/migrate-job.yaml` runs
  `src/migrate.ts` as an Argo CD PreSync hook. There is no equivalent here, so a
  schema change would not be applied. If you add it back, follow the ArgoCD hook
  rules in [AGENTS.md](AGENTS.md).
- **Non-secret env.** `UPLOAD_MAX_MB=1024`, `MAX_PDF_PAGES=5000`,
  `RULE_ANALYSIS_ENABLED=false`, `NODE_OPTIONS=--max-old-space-size=3072`, `NODE_ENV`
  and the `ENTRA_*` non-secret values are set in `deploy/k8s`, not here.
- **Resources.** `base/deployment.yaml` still carries the generator's defaults
  (200m CPU / 128Mi memory limits). `deploy/k8s` sizes this app at 2 CPU / 4Gi
  because a 1 GB scanned upload is buffered in memory and OCR is CPU-bound - 128Mi
  will OOMKill on the first real document.
- **Ingress body size.** `nginx.ingress.kubernetes.io/proxy-body-size` must match
  `UPLOAD_MAX_MB`, otherwise nginx rejects large uploads before the app sees them.

## Cluster setup (run once per environment)

```sh
# ===== one-time, run FIRST: App registration for Key Vault access =====

# Creates the Azure App registration + service principal the Secrets Store CSI
# driver uses to read the Key Vaults, captures its appId + client secret into
# shell variables used by the commands below, and echoes them back.
# (bash / Azure Cloud Shell; secret valid 2 years - save it, it is shown only once)
read -r SP_CLIENT_ID SP_CLIENT_SECRET <<< "$(az ad sp create-for-rbac --name doc-analyzer-kv-reader --years 2 --query '[appId,password]' -o tsv)"
echo "appId / client id: $SP_CLIENT_ID"
echo "client secret:     $SP_CLIENT_SECRET"

# ===== development =====

kubectl create namespace doc-analyzer-dev

# Image pull secret so the cluster can pull the private GHCR image
kubectl -n doc-analyzer-dev create secret docker-registry ghcr-pull-secret --docker-server=ghcr.io --docker-username=<your-gh-username> --docker-password=<a-PAT-with-read:packages>

# Azure Key Vault + the secrets the app reads
az keyvault create --name dcbar-docanalyzer-dev-kv --resource-group DCBAR-K8S-KEYVAULT --location eastus --enable-rbac-authorization false
az keyvault secret set --vault-name dcbar-docanalyzer-dev-kv --name database-url        --value '<postgres://user:pass@host:5432/odc_poc_dev?sslmode=require>'
az keyvault secret set --vault-name dcbar-docanalyzer-dev-kv --name anthropic-api-key   --value '<sk-ant-...>'
az keyvault secret set --vault-name dcbar-docanalyzer-dev-kv --name gptzero-api-key     --value '<gptzero-key>'
az keyvault secret set --vault-name dcbar-docanalyzer-dev-kv --name entra-client-secret  --value '<entra-client-secret>'
az keyvault set-policy --name dcbar-docanalyzer-dev-kv --spn $SP_CLIENT_ID --secret-permissions get
# Entra RBAC: grant the app registration the Key Vault Secrets User role on this vault
az role assignment create --assignee $SP_CLIENT_ID --role "Key Vault Secrets User" --scope $(az keyvault show --name dcbar-docanalyzer-dev-kv --query id -o tsv)

# Service-principal credentials for the Secrets Store CSI driver (uses the captured variables)
kubectl -n doc-analyzer-dev create secret generic secrets-store-creds --from-literal clientid=$SP_CLIENT_ID --from-literal clientsecret=$SP_CLIENT_SECRET
kubectl -n doc-analyzer-dev label secret secrets-store-creds secrets-store.csi.k8s.io/used=true

# TLS certificate for the ingress (wildcard *.dcbar.org cert). Simplest: run this on the
# k8s master, where the cert already lives in ~/certs.
kubectl -n doc-analyzer-dev create secret tls dev-doc-analyzer --cert="$HOME/certs/2026_wildcard_dcbar_org.crt" --key="$HOME/certs/2026_wildcard_dcbar.key"

# ArgoCD Image Updater - auto-deploys new image builds (requires argocd-image-updater in the cluster)
cat <<'EOF' > doc-analyzer-development-updater.yaml
apiVersion: argocd-image-updater.argoproj.io/v1alpha1
kind: ImageUpdater
metadata:
  name: doc-analyzer-development-updater
  namespace: argocd
spec:
  applicationRefs:
  - namePattern: doc-analyzer-development
    useAnnotations: false
    images:
    - alias: doc-analyzer
      imageName: ghcr.io/dc-bar-web/odc-poc
      commonUpdateSettings:
        updateStrategy: newest-build
        pullSecret: pullsecret:argocd/ghcr-pull-secret
        forceUpdate: false
EOF
kubectl apply -f doc-analyzer-development-updater.yaml

# ===== staging =====

kubectl create namespace doc-analyzer-staging

# Image pull secret so the cluster can pull the private GHCR image
kubectl -n doc-analyzer-staging create secret docker-registry ghcr-pull-secret --docker-server=ghcr.io --docker-username=<your-gh-username> --docker-password=<a-PAT-with-read:packages>

# Azure Key Vault + the secrets the app reads
az keyvault create --name dcbar-docanalyzer-stg-kv --resource-group DCBAR-K8S-KEYVAULT --location eastus --enable-rbac-authorization false
az keyvault secret set --vault-name dcbar-docanalyzer-stg-kv --name database-url        --value '<postgres://user:pass@host:5432/odc_poc_staging?sslmode=require>'
az keyvault secret set --vault-name dcbar-docanalyzer-stg-kv --name anthropic-api-key   --value '<sk-ant-...>'
az keyvault secret set --vault-name dcbar-docanalyzer-stg-kv --name gptzero-api-key     --value '<gptzero-key>'
az keyvault secret set --vault-name dcbar-docanalyzer-stg-kv --name entra-client-secret  --value '<entra-client-secret>'
az keyvault set-policy --name dcbar-docanalyzer-stg-kv --spn $SP_CLIENT_ID --secret-permissions get
# Entra RBAC: grant the app registration the Key Vault Secrets User role on this vault
az role assignment create --assignee $SP_CLIENT_ID --role "Key Vault Secrets User" --scope $(az keyvault show --name dcbar-docanalyzer-stg-kv --query id -o tsv)

# Service-principal credentials for the Secrets Store CSI driver (uses the captured variables)
kubectl -n doc-analyzer-staging create secret generic secrets-store-creds --from-literal clientid=$SP_CLIENT_ID --from-literal clientsecret=$SP_CLIENT_SECRET
kubectl -n doc-analyzer-staging label secret secrets-store-creds secrets-store.csi.k8s.io/used=true

# TLS certificate for the ingress (wildcard *.dcbar.org cert). Simplest: run this on the
# k8s master, where the cert already lives in ~/certs.
kubectl -n doc-analyzer-staging create secret tls staging-doc-analyzer --cert="$HOME/certs/2026_wildcard_dcbar_org.crt" --key="$HOME/certs/2026_wildcard_dcbar.key"

# ArgoCD Image Updater - auto-deploys new image builds (requires argocd-image-updater in the cluster)
cat <<'EOF' > doc-analyzer-staging-updater.yaml
apiVersion: argocd-image-updater.argoproj.io/v1alpha1
kind: ImageUpdater
metadata:
  name: doc-analyzer-staging-updater
  namespace: argocd
spec:
  applicationRefs:
  - namePattern: doc-analyzer-staging
    useAnnotations: false
    images:
    - alias: doc-analyzer
      imageName: ghcr.io/dc-bar-web/odc-poc
      commonUpdateSettings:
        updateStrategy: newest-build
        pullSecret: pullsecret:argocd/ghcr-pull-secret
        forceUpdate: false
EOF
kubectl apply -f doc-analyzer-staging-updater.yaml

# ===== production =====

kubectl create namespace doc-analyzer-production

# Image pull secret so the cluster can pull the private GHCR image
kubectl -n doc-analyzer-production create secret docker-registry ghcr-pull-secret --docker-server=ghcr.io --docker-username=<your-gh-username> --docker-password=<a-PAT-with-read:packages>

# Azure Key Vault + the secrets the app reads
az keyvault create --name dcbar-docanalyze-prod-kv --resource-group DCBAR-K8S-KEYVAULT --location eastus --enable-rbac-authorization false
az keyvault secret set --vault-name dcbar-docanalyze-prod-kv --name database-url        --value '<postgres://user:pass@host:5432/odc_poc?sslmode=require>'
az keyvault secret set --vault-name dcbar-docanalyze-prod-kv --name anthropic-api-key   --value '<sk-ant-...>'
az keyvault secret set --vault-name dcbar-docanalyze-prod-kv --name gptzero-api-key     --value '<gptzero-key>'
az keyvault secret set --vault-name dcbar-docanalyze-prod-kv --name entra-client-secret  --value '<entra-client-secret>'
az keyvault set-policy --name dcbar-docanalyze-prod-kv --spn $SP_CLIENT_ID --secret-permissions get
# Entra RBAC: grant the app registration the Key Vault Secrets User role on this vault
az role assignment create --assignee $SP_CLIENT_ID --role "Key Vault Secrets User" --scope $(az keyvault show --name dcbar-docanalyze-prod-kv --query id -o tsv)

# Service-principal credentials for the Secrets Store CSI driver (uses the captured variables)
kubectl -n doc-analyzer-production create secret generic secrets-store-creds --from-literal clientid=$SP_CLIENT_ID --from-literal clientsecret=$SP_CLIENT_SECRET
kubectl -n doc-analyzer-production label secret secrets-store-creds secrets-store.csi.k8s.io/used=true

# TLS certificate for the ingress (wildcard *.dcbar.org cert). Simplest: run this on the
# k8s master, where the cert already lives in ~/certs.
kubectl -n doc-analyzer-production create secret tls production-doc-analyzer --cert="$HOME/certs/2026_wildcard_dcbar_org.crt" --key="$HOME/certs/2026_wildcard_dcbar.key"

# ArgoCD Image Updater - auto-deploys new image builds (requires argocd-image-updater in the cluster)
cat <<'EOF' > doc-analyzer-production-updater.yaml
apiVersion: argocd-image-updater.argoproj.io/v1alpha1
kind: ImageUpdater
metadata:
  name: doc-analyzer-production-updater
  namespace: argocd
spec:
  applicationRefs:
  - namePattern: doc-analyzer-production
    useAnnotations: false
    images:
    - alias: doc-analyzer
      imageName: ghcr.io/dc-bar-web/odc-poc
      commonUpdateSettings:
        updateStrategy: newest-build
        pullSecret: pullsecret:argocd/ghcr-pull-secret
        forceUpdate: false
EOF
kubectl apply -f doc-analyzer-production-updater.yaml

# ===== one-time =====

# Registry credentials the Image Updater uses to query GHCR (argocd namespace)
kubectl -n argocd create secret docker-registry ghcr-pull-secret --docker-server=ghcr.io --docker-username=<your-gh-username> --docker-password=<a-PAT-with-read:packages>
```

Replace `<your-gh-username>`, `<a-PAT-with-read:packages>` and each `<...>` secret value
with your real values. The TLS commands assume the wildcard `*.dcbar.org` cert has been
copied to `/root/certs` (from `~/certs` on the k8s master). Run the commands in bash
(e.g. Azure Cloud Shell) so the captured `$SP_CLIENT_ID` / `$SP_CLIENT_SECRET` variables work.
Key Vaults are created in resource group `DCBAR-K8S-KEYVAULT` (East US). The ImageUpdater
`namePattern` must match your ArgoCD Application name - adjust it if yours differs.

## Validate & apply

```sh
# preview the rendered manifests for each environment
kubectl kustomize overlays/development
kubectl kustomize overlays/staging
kubectl kustomize overlays/production

# apply directly, or let your GitOps controller sync the overlay
kubectl apply -k overlays/development

# verify health before calling the change done (AGENTS.md)
kubectl -n doc-analyzer-dev get pods
kubectl -n doc-analyzer-dev exec deploy/doc-analyzer -- curl -sf http://127.0.0.1:3000/api/health
kubectl -n doc-analyzer-dev logs deploy/doc-analyzer     # on NotReady / CrashLoopBackOff
```

## Regenerate

Re-run the generator to recreate or update this deployment (add `-Force` to overwrite):

```powershell
.\New-K8sDeployment.ps1 -AppName doc-analyzer -Image ghcr.io/dc-bar-web/odc-poc -Tag sha-7bc8882
```