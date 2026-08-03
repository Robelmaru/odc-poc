---
description: Performance review of the pending changes on this branch.
---

Run a focused performance pass over the diff between the current branch and `origin/develop`.

## What to look for

- **N+1 / per-row queries** — loops that issue one `better-sqlite3` query per element instead of a single batched statement.
- **Unbounded loads** — `SELECT *` over a table that grows indefinitely, missing `LIMIT`, endpoints that load every row/document into memory.
- **Sync I/O on hot paths** — blocking file reads in request handlers, synchronous OCR/PDF work that should be backgrounded, synchronous crypto.
- **Large payloads in memory** — multi-megabyte OCR text / PDF buffers held fully in memory rather than streamed.
- **Wasted Claude/API calls** — repeated model calls per request that could be batched or cached; missing token-usage logging; no retry/backoff on rate limits.
- **Memory growth** — caches without bounds, listeners attached without cleanup.

## Report format

For each finding:
- **Likely impact** — `high` | `medium` | `low`
- **File:line** — clickable reference
- **What is happening and why it is slow**
- **Suggested fix** (be concrete; reference functions or query shapes)

Skip micro-optimizations that do not affect real usage.
