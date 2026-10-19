# Contributing Guide

## Running Tests

Each workspace uses exactly one test runner:

| Workspace | Location | Runner | Commands (run from that directory) |
| --- | --- | --- | --- |
| Frontend | repo root (`src/`, `components/`, `contexts/`, ...) | Vitest (`vitest.config.ts`) | `npm test`, `npm run test:run`, `npm run test:coverage` |
| Backend | `backend/` | Jest (`backend/jest.config.js`) | `npm test --prefix backend`, `npm run test:coverage --prefix backend` |

- `npm run test:ci` at the root runs the frontend suite, then the backend suite, the same way CI does.
- Do not add a second runner or a root-level Jest config. New frontend tests use `vitest` globals and imports; new backend tests use Jest.

## Database Migrations

### Naming Convention

Migration directories **must** use ISO timestamp format:

```
YYYYMMDDHHMMSS_descriptive_name
```

Examples:
- `20240325080000_add_database_indexes`
- `20260325164312_add_password_history`

**Do not** use Unix timestamps (e.g. `1711353600_add_database_indexes`).

Prisma sorts migrations alphabetically by directory name. Using ISO timestamps ensures migrations run in chronological order and avoids ambiguity.

To generate a correctly named migration:

```bash
npx prisma migrate dev --name descriptive_name
```

Prisma will automatically prefix the name with the current UTC timestamp in `YYYYMMDDHHMMSS` format.
