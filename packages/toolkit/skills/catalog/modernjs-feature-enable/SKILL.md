---
name: modernjs-feature-enable
description: 在已有的 Modern.js 3.0 应用里启用可选功能（BFF、自定义 Server、Tailwind、SSG、微前端等）。v3 已移除 `modern new`，本 skill 是其手动等价物：装插件 + 改 modern.config + 必要的 tsconfig/scaffold。在「想给现有 Modern.js 项目加 BFF/微前端/Tailwind/SSG 等能力」时使用。
---

# Enable Modern.js Features

为**已有的 Modern.js v3 应用**启用可选功能。

> ⚠️ **`modern new` 在 Modern.js 3.0 已移除**（见 `packages/document/docs/zh/guides/upgrade/other.md:107`、`:111`：「移除了 `modern new` 和 `modern upgrade` 命令，需要按照文档手动操作」「`modern new` 命令在 Modern.js 3.0 中不再支持，无法通过命令添加入口或启用功能」）。
> `packages/document/docs/{zh,en}/apis/app/commands.mdx` 里残留的 `## modern new` 是 **stale doc**，不可作为现行依据，**不要让用户去跑 `modern new`**。本 skill 即官方推荐的「按文档手动操作」的自动化等价物。

## 支持的功能

| 功能 | 参数值 | 状态 | 现行依据（当前仓库文档） |
| --- | --- | --- | --- |
| BFF（一体化后端） | `bff` | ✅ 自动化 | `guides/advanced-features/bff.mdx`、`components/enable-bff.mdx` |
| 静态站点生成 SSG | `ssg` | ✅ 自动化 | `components/enable-ssg.mdx`、`configure/app/output/ssg.mdx` |
| 自定义 Web Server | `server` | 📝 manual | `references/other-features.md` |
| Tailwind CSS | `tailwindcss` | 📝 manual | `references/other-features.md` |
| 微前端（Garfish） | `microFrontend` | 📝 manual | `references/other-features.md` |

> 已自动化：BFF、SSG（完整闭环）；其余功能先给出基于当前文档的人工步骤，后续逐个自动化。

## 执行步骤

### 步骤 1：扫描项目

```bash
node scripts/scan.mjs <projectDir>
```

产出 `context.json`：判定是否 v3（v2 项目先用 `modernjs-migrate-to-v3` 升级）、列出各功能当前是否已启用、是否支持自动化。

### 步骤 2：启用功能

**BFF（自动化）**：

```bash
node scripts/enable.mjs bff <projectDir>
```

自动完成（依据 `components/enable-bff.mdx`）：

- **依赖**：添加 `@modern-js/plugin-bff`，版本与 `@modern-js/app-tools` 保持一致（官方包统一版本号）
- **配置**：`modern.config.*` 顶层 `plugins` 追加 `bffPlugin()`（已有则幂等跳过）
- **tsconfig**：添加 `paths["@api/*"] = ["./api/lambda/*"]` 与 `include` 增加 `api`（非标准 JSON 则进人工清单）
- **scaffold**：无 `api/` 时生成 `api/lambda/index.ts` 示例函数（已有 `api/` 不覆盖）

查看 `.agents/runs/modernjs-feature-enable/report.json` 的 `changed` / `manual`。

**SSG（自动化）**：

```bash
node scripts/enable.mjs ssg <projectDir>
```

自动完成（依据 `components/enable-ssg.mdx`）：添加 `@modern-js/plugin-ssg`（同 app-tools 版本）、`plugins` 追加 `ssgPlugin()`、顶层 `output` 合并 `ssg: true`（已有 output 不覆盖其它字段）。详见 `references/enable-ssg.md`。

> CJS（`module.exports`/`require`）配置会插入 `const { xxxPlugin } = require(...)`；插入失败或无法确定绑定时进人工清单，不写运行时未定义的半成品。

**其它功能（manual）**：读 `references/other-features.md`，按当前文档手动启用。

### 步骤 3：安装依赖 + 验证

读 `references/install-dependencies.md` 选包管理器安装，然后 `modern dev` / `modern build` 验证。

## 安全红线

- 改写优先结构化；解析不了（非标准 JSON、定位不到配置对象）一律进人工清单，不盲改。
- 不覆盖已有 `api/` 等用户文件；已启用的功能幂等跳过。
- 报告区分 `changed`（已自动改写）/ `manual`（需人工）；遇到 `modern new` 这类废弃路径明确标注，不引导用户使用。
