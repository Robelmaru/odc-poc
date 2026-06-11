# Kubernetes manifests — odc-poc

**Kustomize** manifests for staging and production. **Argo CD** reconciles the
cluster to a rendered overlay (GitOps). `docker compose` (repo root) is for local
development only — there is no compose or SSH deploy in staging/production.

## Layout

```
deploy/k8s/
├── base/                     # environment-agnostic manifests
│   ├── deployment.yaml       # the application Deployment (pods), /api/health probes
│   ├── service.yaml          # ClusterIP Service, port 80 → container port 3000
│   ├── ingress.yaml          # Nginx Ingress route + TLS (host patched per overlay)
│   ├── migrate-job.yaml      # drizzle-orm migration Job wired as an Argo CD PreSync hook
│   └── kustomization.yaml
└── overlays/
    ├── staging/    kustomization.yaml   # namespace + image tag + host + 1 replica
    └── production/ kustomization.yaml   # namespace + image tag + host (2 replicas)
```

Argo CD points each environment's `Application` (in `../../argocd/`) at an
**overlay** directory — never at `base/`. It renders Kustomize natively.

## Per-app onboarding (one-time, done by an operator)

1. **Image**: the GHCR package is `ghcr.io/robelmaru/odc-poc` (built/pushed by
   `.github/workflows/build-image.yml`). Adjust `OWNER` if the repo moves orgs.
2. **Secrets**: create the cluster Secrets in each namespace:
   - `ghcr-pull` — image-pull secret for ghcr.io.
   - `odc-poc-secrets` — app config: `DATABASE_URL` (append `?sslmode=require`),
     `ANTHROPIC_API_KEY`, `GPTZERO_API_KEY`, `ENTRA_CLIENT_ID/TENANT_ID/CLIENT_SECRET/REDIRECT_URI/ALLOWED_DOMAINS`,
     `PIN_*`. **Never commit a Secret manifest with real values.**
   - `odc-poc-tls` — org-issued TLS certificate referenced by the Ingress.
3. **Database**: PostgreSQL 16 + pgvector on the dedicated DB server (not in-cluster).
   The PreSync Job applies `backend/migrations/` before each rollout.
4. **Register** the Argo CD Applications:
   `kubectl apply -n argocd -f argocd/applications-staging.yaml` (and `-production`).

## Promotion

`develop` → `staging` (1 authorization, auto-sync) → `main` (2 authorizations,
manual sync). Each promotion PR bumps `images[].newTag` in the target overlay to
the CI-built commit SHA; Argo CD reconciles. Rollback = revert the manifest commit.
