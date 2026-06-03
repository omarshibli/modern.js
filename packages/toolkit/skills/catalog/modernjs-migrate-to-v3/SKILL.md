---
name: modernjs-migrate-to-v3
description: 将一个 Modern.js 2.0 应用迁移到 3.0，优先做可安全自动化的依赖/配置/入口/import 改写，剩余复杂项收敛为人工清单。在「升级 Modern.js 大版本、modern.config 报废弃、要从 webpack/pages 迁到 Rspack/routes、自定义 server 报错」时使用。
---

# Migrate Modern.js 2.0 to 3.0

本 skill 用于单个 Modern.js 应用的 v2→v3 迁移。目标：完成可安全改写的部分，剩余风险收敛成明确人工清单。规则与示例以仓库 `guides/upgrade/*` 的真实文档为准。

## 使用原则

- 调用方先确定 `projectDir`，所有修改仅限 `projectDir`
- 不在开始时读取全部 `references/`；仅在命中人工项时按需加载
- 每个成功步骤结束后提交一次（见 `references/commit-changes.md`）

## 输出要求

- 进度简短：`[X/6] 开始/完成/跳过/失败`
- 非阻断问题记录后继续；阻断问题立即停止并说明步骤、原因、恢复方式

## 前置检查

```bash
git -C <projectDir> status --porcelain
```

工作区非空时停止，提示先 `git commit`/`git stash`。建议在干净分支或 worktree 上迁移，便于回滚。

## 执行步骤

### 步骤 1：扫描项目，生成迁移上下文

```bash
node scripts/scan-project.mjs <projectDir>
```

产出 `<projectDir>/.agents/runs/modernjs-migrate/context.json`：判定 v2/v3、Node 版本、入口类型、命中的 `features`。脚本失败（非 v2/v3、Node 过低）时直接停止并展示原因。`migrationState=v3` 按续迁移处理。

### 步骤 2：执行可安全自动化的改写

```bash
node scripts/migrate.mjs <projectDir> --to=<目标版本>
```

自动完成（依据 `guides/upgrade/*`）：

- **依赖**：`@modern-js/*` 统一升到目标版本（固定版本号）；移除 `@modern-js/plugin-tailwindcss`
- **import 路径**：`@modern-js/runtime/bff`→`@modern-js/plugin-bff/runtime`、`@modern-js/runtime/server`→`@modern-js/server-runtime`，并**补充对应依赖**（`@modern-js/plugin-bff` / `@modern-js/server-runtime`，与 app-tools 同版本）；命中 BFF 时给 `modern.config` 加 `bffPlugin()`（必要时在 `@modern-js/app-tools` import 上补 `appTools`；无法补则进人工清单，不写半成品）
- **配置**：`appTools({ bundler })`→`appTools()`（v3 默认 Rspack，只删 `bundler` 参数）；`modern.config` 顶层 `runtime` 块 → 合并进 `src/modern.runtime.ts`（v3 不再支持在 config 配 runtime；只合并进**空的** `defineRuntimeConfig({})`，非空/函数式进人工清单不覆盖）；`dev.port`→`server.port`（只移顶层 `port`，保留 dev 块其余字段；嵌套如 `dev.client.port` 不动）；移除 tailwind 插件并写 `postcss.config.cjs`
- **入口**：`src/index.*`→`src/entry.*`（bootstrap 函数改写为 `createRoot()`/`render()`）；`App.config` 抽取到 `src/modern.runtime.ts`（**已存在则不覆盖**，进人工清单）
- **运行时**：`useRuntimeContext()` → React 19+ 用 `use(RuntimeContext)`、<19 用 `useContext(RuntimeContext)`（保留 react default/namespace import；`useRuntimeContext as 别名` 进人工清单不假改写）
- **路由**：`src/pages`→`src/routes`（无 routes 时），并改写相对 import 引用，残留进人工清单

> **`applyBaseConfig(...)` 包装的配置**（仓库 integration 测试 helper / 非标准用户配置）：`runtime` / `plugins` / `dev.port` / `appTools bundler` 等**结构性迁移一律进人工清单**（报告标注「结构迁移未完成」），只做依赖升级 / import 路径 / tailwind 移除等文件级安全改写，不在包装内半自动改坏配置。`package.json` 的 `modernConfig.runtime` 同样进人工清单。

完成后查看 `.agents/runs/modernjs-migrate/report.json` 的 `changed` / `manual`。本步骤成功后执行 `references/commit-changes.md`。

### 步骤 3：按人工清单逐项处理（按需读 references）

依据 report 的 `manual` 列表，命中哪项读哪份：

| 人工项 | 参考 |
| --- | --- |
| `App.init` / `routes/layout` 的 `config`/`init` 导出、`modernConfig.runtime`、非空/函数式 `runtime` | `references/migrate-entry.md` |
| 自定义 Web Server（`unstableMiddleware` / `afterRender`） | `references/migrate-custom-server.md` |
| `html.appIcon` 字符串、`server.ssr.mode`、webpack 自定义配置、`applyBaseConfig(...)` 结构性迁移 | `references/migrate-config.md` |
| `useRuntimeContext as 别名` 调用 | `references/migrate-entry.md` |

每处理完一项执行 `references/commit-changes.md`。

### 步骤 4：安装依赖

```bash
bash scripts/install-deps.sh <projectDir>
```

锁文件变更后执行 `references/commit-changes.md`（带 `--include-lockfiles`）。

### 步骤 5：Lint 自动修复

```bash
bash scripts/run-lint.sh <projectDir>
```

失败记录后继续，不视为迁移失败。

### 步骤 6：构建验证 + 最终报告

跑 `modern build`（必要时关键路由 smoke）。最终报告：成功步骤、跳过项、失败项、人工处理项、后续建议。

## 安全红线

- 改写优先结构化；纯文本替换仅用于无歧义项（import 路径）。
- **不手改** `pnpm-lock.yaml` / `dist` / `CHANGELOG` / `node_modules` / secret。
- 复杂、不确定项一律进人工清单，不盲目改。
