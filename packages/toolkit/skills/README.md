# @modern-js/skills

把 Modern.js 官方 **Agent Skills** 显式安装到你项目的 AI Agent 目录（Claude Code / Codex / Cursor）。零依赖，`npx` 直接用。

> 设计原则：**默认不强装、不隐式安装、不拉外部代码** —— 由你显式 `add`。Skill 只是被复制进你选择的 Agent 目录。

## 用法

```bash
# 列出可安装的 Skills
npx @modern-js/skills list

# 安装一个 Skill 到 Agent 目录（会提示选择目标 Agent）
npx @modern-js/skills add modernjs-migrate-to-v3

# 指定目标 Agent 与项目根
npx @modern-js/skills add modernjs-migrate-to-v3 --target=claude,codex --dir=.
```

`--target`：`claude`（→ `.claude/skills/`）、`codex`（→ `.agents/skills/`）、`cursor`（→ `.cursor/skills/`）、`all`。不传时会先提示你选择。

## 当前可安装的 Skills

| Skill | 说明 |
|---|---|
| `modernjs-migrate-to-v3` | v2 → v3 迁移：扫描产出 context.json + 迁移清单（自动/半自动/人工分类），安全改写 import 路径映射 |

> 更多**用户向** Skill（`modernjs-feature-enable` 等）实现中，完成后会加入此包。
> 注：`dependency-audit`、`modernjs-issue-triage` 是**维护者内部** Skill，由仓库根脚本同步到 `.claude/.agents/.cursor`，**不进入本分发包**。

## Skill 源与维护者 Skill

- **用户向 Skill** 的手写源就在本包 `catalog/<skill>/`（直接编辑、随包发布，无需额外同步步骤）。
- **维护者内部 Skill**（如 `dependency-audit`）手写源在仓库根 `skills/<skill>/`，**不进入本包**；维护者用 `pnpm sync:skills`（不带 `--target` 会交互式选 Agent）同步到本仓的 `.claude/.agents/.cursor/skills`。
- `.claude/skills`、`.agents/skills`、`.cursor/skills` 都是安装产物，不是手写源。
