# TB-BE-071 — Runtime Compatibility and Build Verification

**Verification date:** 2026-11-13  
**Scope:** Runtime contract and existing test suite only. This is not staging or production readiness evidence.

## Runtime and package contract

- `package.json` declares `engines.node: ^24.0.0 || ^26.0.0`.
- `package-lock.json` uses lockfile version 3 and repeats the root engine range.
- The PATH runtime is Node **v22.14.0** with npm **11.6.2**. Node 22 is outside the declared range and was not used for the passing verification.
- An already-installed alternate runtime was available at `C:\Users\HariharanCV\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`: Node **v24.22.1**. The npm CLI available in the existing Node installation reported **10.9.2** when invoked under this Node runtime. No installation or version change occurred.

Available scripts in `package.json`:

| Script | Command | Result / applicability |
|---|---|---|
| `test` | `node --test` | Executed under Node 24.22.1; results below. |
| `start` | `node --experimental-strip-types src/server.js` | Not run: application startup needs environment configuration and configured services/adapters; doing so would exceed a safe offline runtime check. |
| `dev` | `node --experimental-strip-types --watch src/server.js` | Development watcher, not a production build check; not run. |
| `test:watch` | `node --test --watch` | Interactive watch mode; not appropriate for this verification. |
| `prisma:generate` | `prisma generate` | No build script exists. Not run because generation can rewrite generated artifacts and was unnecessary for the requested runtime suite. |

There is no declared `build`, `package`, or standalone worker command. `npm start` is the production startup command documented by the project, but it requires production composition and dependencies; it was not invoked. Prisma CLI is a development dependency, so the production-only app artifact must not be assumed to support migration execution.

## Test execution

The first suite attempt used Node 24.22.1 without local-loopback permission. HTTP tests failed at `fetch()` with `fetch failed` before route assertions, matching the known execution-environment restriction. The process did not produce a usable aggregate, so that attempt is not counted as test evidence.

The successful execution was run with permission for the suite's local ephemeral HTTP connections. No external network, database, Redis, KMS, payment, email or blockchain service was contacted.

Exact commands:

```powershell
& 'C:\Users\HariharanCV\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --version
& 'C:\Users\HariharanCV\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js' --version
& 'C:\Users\HariharanCV\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js' test
```

Results:

- Node: **v24.22.1**, satisfies the declared engine range.
- npm CLI: **10.9.2** under the Node 24 runtime; npm version is not constrained by `package.json` engines.
- Full suite: **431 passed, 0 failed, 11 skipped**; TAP total **442** including nested tests.
- The 11 skipped tests are opt-in tests; they are not counted as passing. The full-suite run does not constitute PostgreSQL, Redis, provider, packaging, or deployment verification.

## Assessment and remaining limits

Runtime compatibility of the current source/test suite is verified on Node 24.22.1. Node 26 was not available or tested. The default PATH still selects unsupported Node 22.14.0, so deployment tooling must explicitly use a supported runtime. No build/package script exists, and the production startup path was not exercised because it requires deployment-owned composition and external services. Runtime compatibility does not establish artifact reproducibility, configuration readiness, staging readiness, or production readiness.

The test command required local loopback permission for HTTP integration tests. The successful run used no database or external service. No source, test, manifest, lockfile, schema, migration, generated artifact, or infrastructure file was changed.
