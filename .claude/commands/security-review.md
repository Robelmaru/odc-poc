---
description: Security review of the pending changes on this branch.
---

Run a focused security pass over the diff between the current branch and `origin/develop`. Out of scope: style, architecture, test coverage.

## What to look for

- **Injection** — SQL built via string concatenation (any path that does not use `better-sqlite3` prepared statements with bound parameters), command injection in shell-outs (e.g. `pdf-poppler`/poppler invocations built from user input), unsafe `eval` / `Function`.
- **AuthN/AuthZ** — endpoints that read from a request without checking the user is authenticated (Entra SSO / PIN session), missing access control on case data, secrets read from request bodies.
- **Secret leakage** — secrets logged, secrets in error responses, secrets baked into the Docker image, secrets/PINs committed (check `.env`, `docker-compose.yml`, certificates, key material).
- **Input validation** — request bodies parsed without validation, trust placed in headers / cookies / query without validation, unbounded file uploads (OCR/PDF intake).
- **PII handling** — complaint/case data or uploaded documents written somewhere committed or logged in full.
- **Crypto** — hand-rolled crypto, weak hashes (MD5/SHA1) for security-sensitive purposes, `Math.random()` for security tokens, missing TLS verification on outbound calls.
- **Dependency hygiene** — versions visibly behind, packages with known CVEs that the diff just added.

## Report format

For each finding:
- **Severity** — `critical` | `high` | `medium` | `low`
- **File:line** — clickable reference
- **Why it is a problem**
- **Suggested fix**

If you find nothing, say so plainly.
