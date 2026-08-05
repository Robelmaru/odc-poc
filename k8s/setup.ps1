# Setup script for 'doc-analyzer' - creates the Azure and Kubernetes prerequisites for
# every environment: App registration, Key Vaults, namespaces, image pull secrets,
# CSI driver credentials, TLS secrets and the ArgoCD Image Updater.
#
# Requirements: PowerShell with the az CLI installed (the script signs you in
# if needed) and kubectl pointed at the target cluster.
param(
    [Parameter(Mandatory)][string]$GhUsername,          # GitHub username (GHCR pull secrets)
    [Parameter(Mandatory)][string]$GhPat,               # GitHub PAT with read:packages
    # Values for the four Key Vault secrets the app reads (see README). Omit any to skip
    # creating it - the script then prints the exact 'az keyvault secret set' to run later.
    # Values that differ per environment (database-url especially) can be overridden per
    # vault afterwards; the app will not start until every secret exists in its vault.
    [string]$DatabaseUrl = '',                          # database-url        -> DATABASE_URL
    [string]$AnthropicApiKey = '',                      # anthropic-api-key   -> ANTHROPIC_API_KEY
    [string]$GptzeroApiKey = '',                        # gptzero-api-key     -> GPTZERO_API_KEY
    [string]$EntraClientSecret = '',                    # entra-client-secret -> ENTRA_CLIENT_SECRET
    [string]$AzureSubscription = 'Pay-As-You-Go',      # Azure subscription the resources are created in
    [string]$K8sMasterHost = '10.20.100.241',           # k8s master, used to auto-fetch the kubeconfig via scp
    [string]$K8sMasterUser = 'itadmin',                 # SSH user on the master
    [string]$TlsCertPath = "$HOME\certs\2026_wildcard_dcbar_org.crt",  # wildcard *.dcbar.org certificate
    [string]$TlsKeyPath  = "$HOME\certs\2026_wildcard_dcbar.key",      # its private key
    [switch]$SkipImageUpdater                           # skip the ArgoCD Image Updater resources
)
$ErrorActionPreference = 'Stop'

# The app's Key Vault secrets, in the order the SecretProviderClass objects: array
# lists them. Keep this table in sync with overlays/*/secretproviderclass.yaml.
$AppSecrets = [ordered]@{
    'database-url'        = $DatabaseUrl
    'anthropic-api-key'   = $AnthropicApiKey
    'gptzero-api-key'     = $GptzeroApiKey
    'entra-client-secret' = $EntraClientSecret
}

# Stores every provided secret in $Vault; reports the missing ones instead of
# inventing placeholder values (the pods stay NotReady until they exist).
function Set-AppSecrets {
    param([Parameter(Mandatory)][string]$Vault)
    $missing = @()
    foreach ($name in $AppSecrets.Keys) {
        if ([string]::IsNullOrWhiteSpace($AppSecrets[$name])) { $missing += $name; continue }
        az keyvault secret set --vault-name $Vault --name $name --value $AppSecrets[$name] -o none
    }
    foreach ($name in $missing) {
        Write-Host "  MISSING secret '$name' in $Vault - run: az keyvault secret set --vault-name $Vault --name $name --value '<value>'" -ForegroundColor Yellow
    }
}

# --- prerequisites: required tools must be installed and on PATH ---
foreach ($tool in 'az', 'kubectl') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Host "Required tool '$tool' is not installed or not on PATH." -ForegroundColor Red
        Write-Host "Install it, reopen PowerShell, then re-run this script:" -ForegroundColor Red
        Write-Host "  winget install -e --id Microsoft.AzureCLI"
        Write-Host "  winget install -e --id Kubernetes.kubectl"
        exit 1
    }
}

# --- Azure sign-in (skipped if a session already exists) ---
# az writes warnings to stderr, which Windows PowerShell 5.1 turns into errors
# when piped; keep az quiet for this session so only real errors surface.
$env:AZURE_CORE_ONLY_SHOW_ERRORS = 'true'
$azLoggedIn = $false
try { $null = az account show 2>&1; if ($LASTEXITCODE -eq 0) { $azLoggedIn = $true } } catch { }
if (-not $azLoggedIn) {
    Write-Host "Not signed in to Azure - opening az login..." -ForegroundColor Yellow
    az login -o none
    if ($LASTEXITCODE -ne 0) { Write-Host "az login failed - cannot continue." -ForegroundColor Red; exit 1 }
}
# Select the right subscription (override with -AzureSubscription).
az account set --subscription $AzureSubscription
if ($LASTEXITCODE -ne 0) {
    Write-Host "Could not select subscription '$AzureSubscription'. Available subscriptions:" -ForegroundColor Red
    az account list -o table
    exit 1
}
Write-Host ("Azure subscription: " + (az account show --query name -o tsv)) -ForegroundColor Cyan

# --- cluster connectivity: kubectl needs a context; fetch the kubeconfig if missing ---
$kctx = ""
try { $kctx = "$(kubectl config current-context 2>&1)"; if ($LASTEXITCODE -ne 0) { $kctx = "" } } catch { $kctx = "" }
if (-not $kctx) {
    $kubeconfig = "$HOME\.kube\config"
    if ((-not (Test-Path $kubeconfig)) -and $K8sMasterHost -and (Get-Command scp -ErrorAction SilentlyContinue)) {
        Write-Host "No kubeconfig found - fetching it from $K8sMasterUser@$K8sMasterHost via scp..." -ForegroundColor Yellow
        Write-Host "(you may be prompted for that machine's SSH password)" -ForegroundColor Yellow
        New-Item -ItemType Directory -Force -Path "$HOME\.kube" | Out-Null
        scp -o StrictHostKeyChecking=accept-new "$K8sMasterUser@${K8sMasterHost}:/etc/kubernetes/admin.conf" $kubeconfig
        if ($LASTEXITCODE -eq 0) {
            try { $kctx = "$(kubectl config current-context 2>&1)"; if ($LASTEXITCODE -ne 0) { $kctx = "" } } catch { $kctx = "" }
        }
    }
    if (-not $kctx) {
        Write-Host "kubectl has no cluster context configured on this machine." -ForegroundColor Red
        Write-Host "Copy the cluster's kubeconfig (e.g. /etc/kubernetes/admin.conf from the master," -ForegroundColor Red
        Write-Host "or ask your cluster admin) to $HOME\.kube\config, then re-run this script." -ForegroundColor Red
        exit 1
    }
}
# Guard: the current context must point at the expected master; auto-switch if a
# matching context exists (e.g. Docker Desktop or KUBECONFIG hijacked the default).
$expectedHost = $K8sMasterHost
$server = kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}' 2>$null
if ($expectedHost -and ($server -notmatch [regex]::Escape($expectedHost))) {
    $cfg = kubectl config view -o json | ConvertFrom-Json
    $cluster = ($cfg.clusters | Where-Object { $_.cluster.server -match [regex]::Escape($expectedHost) } | Select-Object -First 1).name
    $target = if ($cluster) { ($cfg.contexts | Where-Object { $_.context.cluster -eq $cluster } | Select-Object -First 1).name } else { $null }
    if ($target) {
        kubectl config use-context $target | Out-Null
        $kctx = $target
        Write-Host "Switched kubectl context to '$target' (matches $expectedHost)." -ForegroundColor Yellow
    } else {
        Write-Host "Current kubectl context points at '$server', not the expected master ($expectedHost)." -ForegroundColor Red
        Write-Host "Fix it, then re-run: clear any KUBECONFIG override (Remove-Item Env:\KUBECONFIG) and/or" -ForegroundColor Red
        Write-Host "select the right context: kubectl config get-contexts / kubectl config use-context <name>" -ForegroundColor Red
        exit 1
    }
}
Write-Host ("Cluster context:    " + $kctx) -ForegroundColor Cyan

# --- one-time: App registration for Key Vault access (secret valid 2 years) ---
$sp = az ad sp create-for-rbac --name doc-analyzer-kv-reader --years 2 -o json | ConvertFrom-Json
$SP_CLIENT_ID = $sp.appId
$SP_CLIENT_SECRET = $sp.password
Write-Host "appId / client id: $SP_CLIENT_ID"
Write-Host "client secret:     $SP_CLIENT_SECRET  (save it - shown only once)"

Write-Host '=== development ===' -ForegroundColor Cyan
kubectl create namespace doc-analyzer-dev --dry-run=client -o yaml | kubectl apply -f -
kubectl -n doc-analyzer-dev create secret docker-registry ghcr-pull-secret --docker-server=ghcr.io --docker-username=$GhUsername --docker-password=$GhPat --dry-run=client -o yaml | kubectl apply -f -
az keyvault create --name dcbar-docanalyzer-dev-kv --resource-group DCBAR-K8S-KEYVAULT --location eastus --enable-rbac-authorization false
Set-AppSecrets -Vault dcbar-docanalyzer-dev-kv
az keyvault set-policy --name dcbar-docanalyzer-dev-kv --spn $SP_CLIENT_ID --secret-permissions get
# Entra RBAC: grant the app registration the Key Vault Secrets User role on this vault
$kvId = az keyvault show --name dcbar-docanalyzer-dev-kv --query id -o tsv
az role assignment create --assignee $SP_CLIENT_ID --role "Key Vault Secrets User" --scope $kvId -o none
if ($LASTEXITCODE -ne 0) { Start-Sleep 15; az role assignment create --assignee $SP_CLIENT_ID --role "Key Vault Secrets User" --scope $kvId -o none }   # retry: new SPs can lag in Entra
kubectl -n doc-analyzer-dev create secret generic secrets-store-creds --from-literal clientid=$SP_CLIENT_ID --from-literal clientsecret=$SP_CLIENT_SECRET --dry-run=client -o yaml | kubectl apply -f -
kubectl -n doc-analyzer-dev label secret secrets-store-creds secrets-store.csi.k8s.io/used=true --overwrite
if ($TlsCertPath -and $TlsKeyPath -and (Test-Path $TlsCertPath) -and (Test-Path $TlsKeyPath)) {
    kubectl -n doc-analyzer-dev create secret tls dev-doc-analyzer --cert=$TlsCertPath --key=$TlsKeyPath --dry-run=client -o yaml | kubectl apply -f -
} elseif ($K8sMasterHost -and (Get-Command ssh -ErrorAction SilentlyContinue)) {
    # No local cert - create the TLS secret ON the master, where ~/certs already has it.
    Write-Host "  Local cert not found - creating TLS secret dev-doc-analyzer on the master over SSH (password prompt possible)..." -ForegroundColor Yellow
    ssh -o StrictHostKeyChecking=accept-new "$K8sMasterUser@$K8sMasterHost" 'kubectl -n doc-analyzer-dev create secret tls dev-doc-analyzer --cert=$HOME/certs/2026_wildcard_dcbar_org.crt --key=$HOME/certs/2026_wildcard_dcbar.key --dry-run=client -o yaml | kubectl apply -f -'
    if ($LASTEXITCODE -ne 0) { Write-Host "  (SSH TLS creation failed - run the kubectl create secret tls command on the master yourself)" -ForegroundColor Red }
} else { Write-Host '  (TLS secret dev-doc-analyzer skipped - wildcard cert not found locally and ssh unavailable. Run the kubectl create secret tls command on the k8s master, where the cert is in ~/certs.)' }
if (-not $SkipImageUpdater) {
@'
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
'@ | kubectl apply -f -
}

Write-Host '=== staging ===' -ForegroundColor Cyan
kubectl create namespace doc-analyzer-staging --dry-run=client -o yaml | kubectl apply -f -
kubectl -n doc-analyzer-staging create secret docker-registry ghcr-pull-secret --docker-server=ghcr.io --docker-username=$GhUsername --docker-password=$GhPat --dry-run=client -o yaml | kubectl apply -f -
az keyvault create --name dcbar-docanalyzer-stg-kv --resource-group DCBAR-K8S-KEYVAULT --location eastus --enable-rbac-authorization false
Set-AppSecrets -Vault dcbar-docanalyzer-stg-kv
az keyvault set-policy --name dcbar-docanalyzer-stg-kv --spn $SP_CLIENT_ID --secret-permissions get
# Entra RBAC: grant the app registration the Key Vault Secrets User role on this vault
$kvId = az keyvault show --name dcbar-docanalyzer-stg-kv --query id -o tsv
az role assignment create --assignee $SP_CLIENT_ID --role "Key Vault Secrets User" --scope $kvId -o none
if ($LASTEXITCODE -ne 0) { Start-Sleep 15; az role assignment create --assignee $SP_CLIENT_ID --role "Key Vault Secrets User" --scope $kvId -o none }   # retry: new SPs can lag in Entra
kubectl -n doc-analyzer-staging create secret generic secrets-store-creds --from-literal clientid=$SP_CLIENT_ID --from-literal clientsecret=$SP_CLIENT_SECRET --dry-run=client -o yaml | kubectl apply -f -
kubectl -n doc-analyzer-staging label secret secrets-store-creds secrets-store.csi.k8s.io/used=true --overwrite
if ($TlsCertPath -and $TlsKeyPath -and (Test-Path $TlsCertPath) -and (Test-Path $TlsKeyPath)) {
    kubectl -n doc-analyzer-staging create secret tls staging-doc-analyzer --cert=$TlsCertPath --key=$TlsKeyPath --dry-run=client -o yaml | kubectl apply -f -
} elseif ($K8sMasterHost -and (Get-Command ssh -ErrorAction SilentlyContinue)) {
    # No local cert - create the TLS secret ON the master, where ~/certs already has it.
    Write-Host "  Local cert not found - creating TLS secret staging-doc-analyzer on the master over SSH (password prompt possible)..." -ForegroundColor Yellow
    ssh -o StrictHostKeyChecking=accept-new "$K8sMasterUser@$K8sMasterHost" 'kubectl -n doc-analyzer-staging create secret tls staging-doc-analyzer --cert=$HOME/certs/2026_wildcard_dcbar_org.crt --key=$HOME/certs/2026_wildcard_dcbar.key --dry-run=client -o yaml | kubectl apply -f -'
    if ($LASTEXITCODE -ne 0) { Write-Host "  (SSH TLS creation failed - run the kubectl create secret tls command on the master yourself)" -ForegroundColor Red }
} else { Write-Host '  (TLS secret staging-doc-analyzer skipped - wildcard cert not found locally and ssh unavailable. Run the kubectl create secret tls command on the k8s master, where the cert is in ~/certs.)' }
if (-not $SkipImageUpdater) {
@'
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
'@ | kubectl apply -f -
}

Write-Host '=== production ===' -ForegroundColor Cyan
kubectl create namespace doc-analyzer-production --dry-run=client -o yaml | kubectl apply -f -
kubectl -n doc-analyzer-production create secret docker-registry ghcr-pull-secret --docker-server=ghcr.io --docker-username=$GhUsername --docker-password=$GhPat --dry-run=client -o yaml | kubectl apply -f -
az keyvault create --name dcbar-docanalyze-prod-kv --resource-group DCBAR-K8S-KEYVAULT --location eastus --enable-rbac-authorization false
Set-AppSecrets -Vault dcbar-docanalyze-prod-kv
az keyvault set-policy --name dcbar-docanalyze-prod-kv --spn $SP_CLIENT_ID --secret-permissions get
# Entra RBAC: grant the app registration the Key Vault Secrets User role on this vault
$kvId = az keyvault show --name dcbar-docanalyze-prod-kv --query id -o tsv
az role assignment create --assignee $SP_CLIENT_ID --role "Key Vault Secrets User" --scope $kvId -o none
if ($LASTEXITCODE -ne 0) { Start-Sleep 15; az role assignment create --assignee $SP_CLIENT_ID --role "Key Vault Secrets User" --scope $kvId -o none }   # retry: new SPs can lag in Entra
kubectl -n doc-analyzer-production create secret generic secrets-store-creds --from-literal clientid=$SP_CLIENT_ID --from-literal clientsecret=$SP_CLIENT_SECRET --dry-run=client -o yaml | kubectl apply -f -
kubectl -n doc-analyzer-production label secret secrets-store-creds secrets-store.csi.k8s.io/used=true --overwrite
if ($TlsCertPath -and $TlsKeyPath -and (Test-Path $TlsCertPath) -and (Test-Path $TlsKeyPath)) {
    kubectl -n doc-analyzer-production create secret tls production-doc-analyzer --cert=$TlsCertPath --key=$TlsKeyPath --dry-run=client -o yaml | kubectl apply -f -
} elseif ($K8sMasterHost -and (Get-Command ssh -ErrorAction SilentlyContinue)) {
    # No local cert - create the TLS secret ON the master, where ~/certs already has it.
    Write-Host "  Local cert not found - creating TLS secret production-doc-analyzer on the master over SSH (password prompt possible)..." -ForegroundColor Yellow
    ssh -o StrictHostKeyChecking=accept-new "$K8sMasterUser@$K8sMasterHost" 'kubectl -n doc-analyzer-production create secret tls production-doc-analyzer --cert=$HOME/certs/2026_wildcard_dcbar_org.crt --key=$HOME/certs/2026_wildcard_dcbar.key --dry-run=client -o yaml | kubectl apply -f -'
    if ($LASTEXITCODE -ne 0) { Write-Host "  (SSH TLS creation failed - run the kubectl create secret tls command on the master yourself)" -ForegroundColor Red }
} else { Write-Host '  (TLS secret production-doc-analyzer skipped - wildcard cert not found locally and ssh unavailable. Run the kubectl create secret tls command on the k8s master, where the cert is in ~/certs.)' }
if (-not $SkipImageUpdater) {
@'
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
'@ | kubectl apply -f -
}

# --- one-time: registry credentials the Image Updater uses to query GHCR ---
if (-not $SkipImageUpdater) {
    kubectl -n argocd create secret docker-registry ghcr-pull-secret --docker-server=ghcr.io --docker-username=$GhUsername --docker-password=$GhPat --dry-run=client -o yaml | kubectl apply -f -
}

Write-Host 'Setup complete.' -ForegroundColor Green