# 配置迁移（人工项）

> `migrate.mjs` 已自动处理 `dev.port`→`server.port`、移除 tailwind 插件 + 写 `postcss.config.cjs`。
> 本文覆盖需人工判断的配置项。依据 `guides/upgrade/config`、`guides/upgrade/other`、`guides/upgrade/tailwindcss`。

## html.appIcon：字符串 → 对象

```ts
// v2
html: { appIcon: './src/assets/icon.png' }
// v3
html: { appIcon: { icons: [{ src: './src/assets/icon.png', size: 180 }] } }
```

## server.ssr.mode：默认 'string' → 'stream'

v3 启用 SSR 时默认流式渲染。**React 17 项目需手动设回 `'string'`**：
```ts
server: { ssr: { mode: 'string' } }
```
React 18+ 且未在 Data Loader 用 Suspense 时，保持默认 `'stream'` 渲染结果不变。

## webpack → Rspack

v3 不再支持 webpack，默认 Rspack（与 webpack 配置高度兼容）。检查 `tools.webpack` / `webpackChain` 等自定义配置与自定义插件是否有 Rspack 对应版本。

## Tailwind（自动迁移补充）

`migrate.mjs` 已移除 `@modern-js/plugin-tailwindcss` 并写 `postcss.config.cjs`。仍需人工确认：
- Tailwind 配置统一进 `tailwind.config.{ts,js}`（若原本只在 `modern.config.ts` 配置）。
- CSS 引入从 `@import 'tailwindcss/*.css'` 改为 `@tailwind base/components/utilities;`。

## 其他

- 不再支持 `pages` 目录约定式路由（`migrate.mjs` 会把 `src/pages`→`src/routes`；复杂动态路由迁移后需人工核对）。
- 默认使用 React Router v7（相比 v6 少量不兼容）；需 v5/v6 走自控式路由。
