# 其它功能（manual checklist）

> 第一版未自动化，依据当前仓库文档给出人工步骤。装官方插件时，**版本一律与 `@modern-js/app-tools` 一致**
> （官方包统一版本号）。改 `modern.config` 时把插件**追加到顶层 `plugins`**，不要动其它插件顺序。

## 静态站点生成 SSG（`ssg`）

依据 `packages/document/docs/zh/components/enable-ssg.mdx`、`configure/app/output/ssg.mdx`：

1. `pnpm add @modern-js/plugin-ssg@<app-tools 同版本>`
2. `modern.config`：
   ```ts
   import { ssgPlugin } from '@modern-js/plugin-ssg';
   export default defineConfig({
     plugins: [appTools(), ssgPlugin()],
     output: { ssg: true },
   });
   ```

## 自定义 Web Server（`server`）

依据 `packages/document/docs/zh/apis/app/hooks/server/server.mdx`（与 `guides/upgrade/web-server`）：

1. 新建 `server/modern.server.ts`：
   ```ts
   import { defineServerConfig } from '@modern-js/server-runtime';
   export default defineServerConfig({
     middlewares: [/* { name, handler } */],
   });
   ```
2. 需要 `@modern-js/server-runtime`（与 app-tools 同版本）。中间件 Context 为 Hono，必须 `await next()`。

## Tailwind CSS（`tailwindcss`）

依据 `packages/document/docs/zh/guides/basic-features/css/tailwindcss.mdx`：

v3 **不再使用 `@modern-js/plugin-tailwindcss`**，改为 Rsbuild 原生方式：

1. 安装 `tailwindcss`（v3 或 v4）及其 PostCSS 依赖，按 Rsbuild 文档配置：
   - Tailwind v3：https://rsbuild.rs 的 tailwindcss-v3 指南
   - Tailwind v4：https://rsbuild.rs 的 tailwindcss 指南
2. 创建 `tailwind.config.{ts,js}`（IDE 智能补全也需要）。
3. 在入口 CSS 引入 Tailwind 指令（`@tailwind base/components/utilities;` 或 v4 的 `@import`）。

> 若项目是从 v2 迁移来的、仍有 `@modern-js/plugin-tailwindcss`，用 `modernjs-migrate-to-v3` 处理。

## 微前端 / Garfish（`microFrontend`）

依据 `packages/document/docs/zh/components/micro-frontend.mdx` 及微前端指南。该能力依赖 Garfish 相关插件
（`@modern-js/plugin-garfish`，不在本仓库 monorepo 内），主从应用配置项较多：请**以当前微前端文档为准**确认
插件名、`masterApp` / 子应用导出等配置后再启用，不要凭记忆配置。

---

> 以上能力会随 BFF 闭环验证通过后逐个补成 `scripts/enable.mjs` 的自动化分支 + tests/skill 断言。
