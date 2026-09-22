# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

QSerial 是一个 AI 驱动的串口控制台与设备管理工具（Electron 35 + React 18 + TypeScript + pnpm monorepo）。核心特色是内嵌 MCP (Model Context Protocol) 服务器，让外部 AI Agent 通过 5 个命名空间（`conn`/`device`/`session`/`sftp`/`app`）的约 47 个工具直接操控本地硬件连接。

## 常用命令

```bash
pnpm install                # 安装依赖（注意 .npmrc 强制 node-linker=hoisted + npmmirror 镜像）
pnpm run dev                # 开发模式：编译 shared/main + Vite(5173) HMR + Electron
./dev.sh                    # 同上，Linux/WSL 一键脚本（含残留进程清理：端口 5173/9800）
pnpm start                  # 运行预构建产物（不启动 Vite）
pnpm run build              # 构建 shared → main → renderer（顺序有依赖）
pnpm test                   # 运行全部 vitest 测试
pnpm test packages/shared   # 只跑某个包的测试（vitest 路径过滤）
npx vitest run packages/shared/__tests__/xxx.test.ts   # 跑单个测试文件
pnpm run test:coverage      # 带 V8 覆盖率（packages/shared/src 阈值 85%）
pnpm run lint / lint:fix    # ESLint（仅 packages/*/src）
pnpm run format             # Prettier
pnpm run package:win        # 打包 Windows 安装包 + 便携版
./build-win.sh [--deploy]   # Linux/WSL 一键构建 Windows 产物（--deploy 经 scp 上传服务器，配置见 .env）
```

测试位于 `packages/*/__tests__/`，目录结构与源码对应。

## 架构大图

**pnpm workspace 三包结构**（依赖方向：main → shared ← renderer）：

- `packages/main` — Electron 主进程。入口 `src/index.ts`（构建为 ESM `index.mjs`，preload 为 CJS）。关键子目录：
  - `src/services/connection/` — 连接层。统一抽象 `IConnection`（定义在 shared 包），`factory.ts` 按 `ConnectionType` 创建 serial / ssh / telnet / pty / connection-server（Telnet 共享服务端）实现
  - `src/services/mcp/` — 内嵌 HTTP MCP 服务器（默认端口 9800，`manager.ts`），支持 SSE 与 streamable-http 双传输、Bearer token 鉴权。**工具定义与 handler 分离**：`tools/*.ts` 按域拆分 handler（connection/connection-io/connection-advanced/sftp/device/session/app/buttons），经 `getMcpToolDefinitions/getMcpToolHandler` 注册；`ai-helpers.ts` 提供 `formatOk()/formatError()` 统一返回格式
  - `src/plugins/` — 插件系统宿主：`registry.ts`（贡献注册表，桥接 MCP 工具）、`permissions.ts`（运行时权限裁剪）、`host-api.ts`（受限 `ctx` API）、`market.ts`（插件市场）
  - `src/ipc/handlers.ts` — IPC handler 注册
- `packages/renderer` — React 前端。xterm.js 终端、Zustand + immer stores（`src/stores/`，命名 `useFooStore`）、react-i18n（`src/i18n/locales/{zh-CN,en-US}.json`）
- `packages/shared` — 跨进程契约：`IPC_CHANNELS` 常量、`IConnection` 接口、连接/会话/插件类型。**改 IPC 协议或连接接口必须从这里开始**，main 与 renderer 都依赖它

**两条并行的设备访问路径**（这是理解本项目的关键）：

1. UI 路径：renderer → IPC (`namespace:action` 频道) → main 的 connection 服务 → 硬件
2. AI 路径：外部 AI Agent → MCP HTTP (9800) → `tools/*.ts` handler → 同一套 ConnectionFactory → 硬件

两条路径汇聚于同一连接层，MCP 工具与 UI 操作看到相同的连接状态。

**插件系统**：插件运行在主进程，通过 `activate(ctx)` 收到按权限裁剪的受限 API（`connection:read/write`、`mcp:register`、`device:register`、`ui` 等），不能直接访问 Node 原生模块。插件放在仓库根 `plugins/`（内置）或 `<userData>/plugins/`，清单为其 `package.json` 中的 `qserial` 字段。详见 `docs/PLUGIN_DEV_GUIDE.md`。

**原生模块处理**：serialport / node-pty / ssh2 / tftp 等为 esbuild external，不做打包；`native-patch.ts` 会拦截 `process.dlopen`，在网络驱动器（如 SMB 挂载）场景自动把 `.node` 文件复制到本地临时目录再加载——在 Samba/NFS 路径下开发时此补丁是必需的。

## 代码约定（详见 AGENTS.md）

- 2 空格缩进、单引号、分号；TS 未开 strict，但 `no-explicit-any` 为 error
- 模块文件 `kebab-case.ts`，React 组件 `PascalCase.tsx`
- IPC 频道 `namespace:action`（如 `serial:list`）；MCP 工具 `namespace.action`（如 `conn.data.send`）
- 所有用户可见文本必须走 react-i18next（key 模式 `section.subsection.key`），中英 locale 同步更新
- 提交信息：`feat(scope): ...` / `fix(scope): ...`，scope 示例：`mcp`、`sftp`、`recording`、`i18n`、`build`

## 环境注意事项

- `.npmrc` 锁定 npmmirror registry 与 electron/ffmpeg 国内镜像（GitHub 直连易超时）；`node-linker=hoisted` 使 node_modules 为真实目录而非 symlink，这是 WSL 与 Windows 共享同一 node_modules 的前提——若发现 symlink 结构需在 WSL 重新 `pnpm install`
- Node >= 20，包管理器锁定 pnpm@8.15.0
