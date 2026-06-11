# DB-006 — jsonb columns + boolean flags (remaining work)

The first half of DB-006 is **done**: the `record_shares` junction table replaced the
`shared_with` LIKE scan (migration `0001`, `record_shares` is source of truth,
`shared_with` TEXT kept as a write-through cache). This document is the plan for the
**remaining** half — converting JSON-bearing `text` columns to `jsonb` and `0/1`
`integer` flags to `boolean`.

## ⚠️ Read first: this is an API-contract change, not backend-only

These columns are returned verbatim in API responses and consumed by `frontend/index.html`:

- **Flags** (`users.active`, `notifications.read`, `productions.is_image_only`) are
  exposed today as **`0` / `1`**. Converting to `boolean` makes the JSON
  **`false` / `true`**. Any frontend check like `=== 1` / `=== 0` breaks; truthy
  checks (`if (x)`) are fine. `productions.is_image_only` is written via an explicit
  `boolean → 1/0` conversion at `db/discovery.ts:337` and read as `number` (`:67`).
- **jsonb columns** (`file_names`, `tags`, `timeline`, `translation`,
  `requested_items`, `rule115_flags`) are stringified on write / `safeJsonParse`d on
  read today. With `jsonb`, `pg` parses them to objects automatically — so the API
  returns parsed objects where it may currently return strings in a few spots; verify
  each response shape against the frontend.

**Therefore: execute as ONE coordinated backend + frontend pass, AFTER the current
WIP (`index.ts`, `translate.ts`, `pdfUtils.ts`, `frontend/index.html`) is committed.**
Do not run it under an in-progress frontend.

## Procedure for every migration in this plan

1. Edit `backend/src/db/schema.ts` (column type).
2. `pnpm db:generate` → it emits an `ALTER ... SET DATA TYPE` **without** a `USING`
   clause, which fails on existing data. **Hand-edit** the generated
   `migrations/0002_*.sql` to add the cast (see below).
3. **Commit `migrations/meta/_journal.json` + the new `*_snapshot.json`** alongside
   the `.sql` — the migrator enumerates from the journal; without it a fresh
   checkout/CI silently skips the migration. (This bit us on `0001`.)
4. Apply to dev + test: `node --env-file=.env --import=tsx src/migrate.ts`, then again
   with `DATABASE_URL` pointed at `odc_poc_test`.
5. Update the code touch-points (below), `pnpm typecheck && pnpm lint && pnpm test`.
6. Update the affected frontend reads. Commit per logical step.

## Step 1 — boolean flags (do first; smallest blast radius)

**Schema** (`schema.ts`, import `boolean` from `drizzle-orm/pg-core`):
- `users.active`: `integer(...).notNull().default(1)` → `boolean(...).notNull().default(true)`
- `notifications.read`: `integer(...).notNull().default(0)` → `boolean(...).notNull().default(false)`
- `productions.isImageOnly`: `integer("is_image_only")` → `boolean("is_image_only")` (nullable)

**Migration `USING` casts** (hand-edit):
```sql
ALTER TABLE "users" ALTER COLUMN "active" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "active" SET DATA TYPE boolean USING ("active" <> 0);
ALTER TABLE "users" ALTER COLUMN "active" SET DEFAULT true;
ALTER TABLE "notifications" ALTER COLUMN "read" DROP DEFAULT;
ALTER TABLE "notifications" ALTER COLUMN "read" SET DATA TYPE boolean USING ("read" <> 0);
ALTER TABLE "notifications" ALTER COLUMN "read" SET DEFAULT false;
ALTER TABLE "productions" ALTER COLUMN "is_image_only" SET DATA TYPE boolean USING ("is_image_only" <> 0);
```

**Backend touch-points:**
- `db/database.ts`: seed `INSERT ... VALUES (?, ?, ?, 1)` → `true`; `markNotificationRead`/`markAllNotificationsRead` `SET read = 1` → `true`; `getUnreadNotificationCount` `WHERE read = 0` → `WHERE read = false` (or `NOT read`); `User.active` type `number` → `boolean`; `getSessionUser` return `active: number` → `boolean` (the `!row.active` checks still work).
- `db/discovery.ts`: `Production.is_image_only` type `number|null` → `boolean|null`; drop the `? 1 : 0` conversion at the write site (`:337`) — pass the boolean directly.
- `routes/records.ts`: `updateUserActive(Number(user_id), !!active)` already passes a boolean — fine.

**Frontend touch-points** (`frontend/index.html`): find every `is_image_only`,
`.read`, and `active` comparison; replace `=== 1`/`=== 0`/`== 1` with boolean checks.
Admin user list (active), notifications (read), discovery production cards
(is_image_only) are the likely spots.

## Step 2 — jsonb columns (one column at a time)

For each of `file_names`, `tags`, `timeline`, `translation`, `requested_items`,
`rule115_flags` (and optionally retire the `shared_with` cache in favour of building
the array from `record_shares`):

**Migration cast:** `ALTER TABLE t ALTER COLUMN c SET DATA TYPE jsonb USING NULLIF(c,'')::jsonb;`
(guard empties; defaults `'[]'` become `'[]'::jsonb`).

**Backend:** on write, pass the object (drop `JSON.stringify`); on read, use the value
directly (drop `safeJsonParse` — `pg` already returns parsed jsonb). Update the column
TS types from `string` to the parsed shape. Do **one column per migration/commit** and
run the suite between each — this is where response shapes can shift.

**Frontend:** verify each consuming view still receives the same shape (it should, since
the app already parsed these before display).

## Rollback

Each step is a forward migration; to roll back, write the inverse `ALTER ... USING`
(`boolean → integer USING (CASE WHEN c THEN 1 ELSE 0 END)`, `jsonb → text USING c::text`).
Keep steps small so a rollback is one column/flag at a time.

## Value note

This is a **refinement** (cleaner types), not a platform-standard deviation — the app is
correct today with `text`/`integer`. Prioritize it below anything functional; its main
benefit is type-safety and enabling future `jsonb` queries.
