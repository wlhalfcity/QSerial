# 全局偏好

## 回复语言

默认使用简体中文回复用户；仅在用户明确要求其他语言时切换。代码、命令、路径及必要的技术名称保留原文。

---

# Repository Guidelines

## Project Structure

```
QSerial/
├── packages/
│   ├── main/           # Electron main process (IPC, services, MCP tools)
│   │   └── src/services/  # connection/, ftp/, mcp/, nfs/, sftp/, tftp/
│   ├── renderer/       # React frontend (components, stores, i18n)
│   │   └── src/components/  # common/, dialogs/, layout/, sftp/, tabs/, terminal/
│   └── shared/         # TypeScript types and constants shared across processes
├── plugins/            # Community plugins and device models
├── scripts/            # Build, deploy, packaging, and helper scripts
├── resources/          # App icon and bundled assets
├── build/              # Build-time icons and config
├── ci/                 # CI test samples
└── .github/workflows/  # GitHub Actions (ci.yml, build.yml, hardware-ci.yml)
```

## Build, Test, and Development Commands

| Command | Purpose |
|---------|---------|
| `pnpm run dev` | Full dev mode: builds all packages, starts Vite (port 5173), then Electron |
| `pnpm start` | Launch Electron with pre-built renderer (no Vite) |
| `pnpm run build` | Build shared → main → renderer sequentially |
| `pnpm test` | Run all vitest tests (13 suites, ~135 cases) |
| `pnpm run test:coverage` | Run tests with V8 coverage (shared/src threshold: 85%) |
| `pnpm run lint` | ESLint on all source packages |
| `pnpm run lint:fix` | ESLint with auto-fix |
| `pnpm run format` | Prettier formatting |
| `pnpm run package:win` | Package Windows installer + portable exe |
| `./build-win.sh [--deploy]` | One-click Windows build on Linux/WSL2; `--deploy` uploads artifacts to the server configured in `.env` |

Tests live in `packages/*/__tests__/` matching the source structure. Use `describe`/`it` from vitest.

## Coding Style

- **Indentation**: 2 spaces (see `.editorconfig`)
- **Quotes**: single quotes, semicolons required
- **TypeScript**: strict mode disabled, `no-explicit-any` is an error
- **Linting**: ESLint with `@typescript-eslint/recommended` + Prettier
- **Formatting**: Prettier before commit (`pnpm run format`)
- **Styling**: Tailwind CSS for all UI components

## Naming Conventions

- **Files**: `kebab-case.ts` for modules, `PascalCase.tsx` for React components
- **IPC channels**: `namespace:action` (e.g., `serial:list`, `mcp:start`)
- **MCP tools**: `namespace.action` (e.g., `conn.data.send`, `sftp.upload`)
- **Stores**: `useFooStore` with Zustand + immer
- **Interfaces**: `PascalCase` prefixed by domain (`SerialConnectionOptions`)

## Commit Conventions

Follow the existing pattern — semantic prefixes with scope:

```
feat(scope): short description
fix(scope): short description
chore(scope): short description
```

Example scopes: `mcp`, `sftp`, `macro`, `recording`, `i18n`, `build`, `resources`.

## i18n

Use `react-i18next` for all user-facing text. Import with `import { useTranslation } from 'react-i18next'`. Locale files: `packages/renderer/src/i18n/locales/{zh-CN,en-US}.json`. Key pattern: `section.subsection.key`.

## MCP Tools

Define tools in `packages/main/src/services/mcp/tools/`. Use `formatOk()` and `formatError()` from `ai-helpers.ts`. Register new tools by adding handlers to the appropriate module file.
