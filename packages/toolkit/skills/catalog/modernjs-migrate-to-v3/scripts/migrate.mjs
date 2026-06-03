#!/usr/bin/env node
// 对一个 Modern.js v2 项目执行**可安全自动化**的 v2→v3 改写，并把复杂项列入人工清单。
//   node scripts/migrate.mjs <projectDir> [--to=<version>] [--json]
//
// 自动改写（依据 guides/upgrade/*）：
//   - 依赖：@modern-js/* 统一升到目标版本；移除 @modern-js/plugin-tailwindcss
//   - import 路径：runtime/bff→plugin-bff/runtime、runtime/server→server-runtime
//   - 配置：dev.port→server.port；移除 tailwind 插件 import/调用 + 写 postcss.config.cjs
//   - 入口：src/index.* → src/entry.*（bootstrap 函数改写为 createRoot/render）
//   - App.config → src/modern.runtime.ts 的 defineRuntimeConfig
//   - useRuntimeContext() → use(RuntimeContext)
//   - src/pages → src/routes（无 routes 时）
// 人工清单（语义复杂，不自动）：App.init / layout init、自定义 server、html.appIcon、
//   server.ssr.mode、webpack 自定义配置。

import fs from 'node:fs';
import path from 'node:path';

const SRC_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.agents',
  'coverage',
]);

const changed = [];
const manual = [];
const note = (list, msg) => list.push(msg);

const readText = f => fs.readFileSync(f, 'utf8');
const exists = (...p) => fs.existsSync(path.join(...p));

function collectSources(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORED.has(e.name)) collectSources(full, files);
    } else if (SRC_EXT.has(path.extname(e.name)) && !e.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

// 从 `key = {` 之后做花括号配平，返回对象字面量文本与结束位置
function extractBalanced(text, startIdx) {
  let depth = 0;
  for (let i = startIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { body: text.slice(startIdx, i + 1), end: i + 1 };
    }
  }
  return null;
}

// ---- 1) 依赖 ----
function migrateDeps(dir, toVersion) {
  const file = path.join(dir, 'package.json');
  const pkg = JSON.parse(readText(file));
  let touched = false;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[field];
    if (!deps) continue;
    if (deps['@modern-js/plugin-tailwindcss']) {
      delete deps['@modern-js/plugin-tailwindcss'];
      touched = true;
    }
    for (const name of Object.keys(deps)) {
      if (name.startsWith('@modern-js/') && deps[name] !== toVersion) {
        deps[name] = toVersion;
        touched = true;
      }
    }
  }
  if (touched) {
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
    note(
      changed,
      `依赖：@modern-js/* 统一升到 ${toVersion}，移除 plugin-tailwindcss`,
    );
  }
}

// ---- 2) import 路径映射 ----
function migrateImportPaths(files) {
  const map = [
    ['@modern-js/runtime/bff', '@modern-js/plugin-bff/runtime'],
    ['@modern-js/runtime/server', '@modern-js/server-runtime'],
  ];
  const hit = [];
  for (const f of files) {
    let code = readText(f);
    let c = false;
    for (const [from, to] of map) {
      if (code.includes(from)) {
        code = code.split(from).join(to);
        c = true;
      }
    }
    if (c) {
      fs.writeFileSync(f, code);
      hit.push(path.basename(f));
    }
  }
  if (hit.length) note(changed, `import 路径映射：${hit.join(', ')}`);
}

// ---- 3) 配置：dev.port→server.port、移除 tailwind 插件 ----
function migrateConfig(dir) {
  const configFile = [
    'modern.config.ts',
    'modern.config.js',
    'modern.config.mjs',
  ].find(f => exists(dir, f));
  if (!configFile) return false;
  const file = path.join(dir, configFile);
  let code = readText(file);
  const before = code;
  let hadTailwind = false;

  // dev: { port: X } -> server.port（已有 server 块则合并进去，否则新增 server 块）
  const devPort = code.match(
    /\bdev\s*:\s*\{\s*port\s*:\s*([^,}]+?)\s*,?\s*\}\s*,?/,
  );
  if (devPort) {
    const port = devPort[1].trim();
    code = code.replace(devPort[0], '');
    const server = code.match(/\bserver\s*:\s*\{/);
    if (server) {
      const at = server.index + server[0].length;
      code = `${code.slice(0, at)} port: ${port},${code.slice(at)}`;
    } else {
      code = code.replace(
        /defineConfig\(\s*\{/,
        `defineConfig({\n  server: { port: ${port} },`,
      );
    }
  }

  // 移除 tailwind 插件 import 行 + plugins 数组里的调用
  if (/plugin-tailwindcss|tailwindcssPlugin/.test(code)) {
    hadTailwind = true;
    code = code
      .split('\n')
      .filter(
        line => !/from\s+['"]@modern-js\/plugin-tailwindcss['"]/.test(line),
      )
      .join('\n');
    code = code.replace(/tailwindcssPlugin\(\s*\)\s*,?/g, '');
  }

  if (code !== before) {
    fs.writeFileSync(file, code);
    note(
      changed,
      `配置 ${configFile}：dev.port→server.port${hadTailwind ? '、移除 tailwind 插件' : ''}`,
    );
  }
  return hadTailwind;
}

// ---- 4) 入口：index→entry（含 bootstrap 改写）、App.config 抽取 ----
function migrateEntry(dir) {
  const src = path.join(dir, 'src');
  // 4a. 自定义入口 index.* -> entry.*
  for (const ext of ['tsx', 'jsx', 'ts', 'js']) {
    const idx = path.join(src, `index.${ext}`);
    if (fs.existsSync(idx)) {
      let code = readText(idx);
      // bootstrap 函数：export default (App, bootstrap) => { ... }
      const m = code.match(
        /export\s+default\s*(?:async\s*)?\(\s*\w+[^)]*,\s*(\w+)[^)]*\)\s*=>\s*\{([\s\S]*)\}\s*;?\s*$/,
      );
      if (m) {
        const bootstrapName = m[1];
        const body = m[2].replace(
          new RegExp(`\\b${bootstrapName}\\s*\\(\\s*\\)`, 'g'),
          'render(<ModernRoot />)',
        );
        code = [
          `import { createRoot } from '@modern-js/runtime/react';`,
          `import { render } from '@modern-js/runtime/browser';`,
          '',
          `const ModernRoot = createRoot();`,
          '',
          `async function beforeRender() {${body}}`,
          '',
          `beforeRender();`,
          '',
        ].join('\n');
        note(changed, 'bootstrap 入口改写为 createRoot()/render()');
      }
      const entry = path.join(src, `entry.${ext}`);
      fs.writeFileSync(entry, code);
      fs.rmSync(idx);
      note(changed, `入口重命名：src/index.${ext} → src/entry.${ext}`);
      break;
    }
  }

  // 4b. App.config 抽取到 modern.runtime.ts
  const appFile = ['App.tsx', 'App.jsx']
    .map(f => path.join(src, f))
    .find(fs.existsSync);
  let runtimeConfigBody = null;
  if (appFile) {
    let code = readText(appFile);
    const cfgMatch = code.match(/App\.config\s*=\s*\{/);
    if (cfgMatch) {
      const braceStart = cfgMatch.index + cfgMatch[0].length - 1;
      const ext = extractBalanced(code, braceStart);
      if (ext) {
        runtimeConfigBody = ext.body;
        // 删除整条 App.config = {...};
        const full = code.slice(cfgMatch.index, ext.end).replace(/;?\s*$/, '');
        code = code.replace(full, '').replace(/App\.config\s*=\s*;?/g, '');
        code = code.replace(/\n{3,}/g, '\n\n');
        fs.writeFileSync(appFile, code);
        note(changed, 'App.config 抽取到 src/modern.runtime.ts');
      }
    }
    if (/\bApp\.init\b/.test(readText(appFile))) {
      note(
        manual,
        'App.init：需改为运行时插件（defineRuntimeConfig.plugins，见 references/migrate-entry.md）',
      );
    }
  }
  if (runtimeConfigBody) {
    const rtFile = path.join(src, 'modern.runtime.ts');
    const content = [
      `import { defineRuntimeConfig } from '@modern-js/runtime';`,
      '',
      `export default defineRuntimeConfig(${runtimeConfigBody});`,
      '',
    ].join('\n');
    fs.writeFileSync(rtFile, content);
    note(changed, '生成 src/modern.runtime.ts');
  }

  // 4c. routes/layout 的 config/init 导出 → 人工
  const layout = ['routes/layout.tsx', 'routes/layout.jsx']
    .map(f => path.join(src, f))
    .find(fs.existsSync);
  if (layout && /export\s+const\s+(config|init)\b/.test(readText(layout))) {
    note(
      manual,
      'routes/layout 的 config/init 导出：需迁到 modern.runtime.ts（见 references/migrate-entry.md）',
    );
  }
}

// ---- 5) useRuntimeContext → use(RuntimeContext) ----
function migrateRuntimeContext(files) {
  const hit = [];
  for (const f of files) {
    let code = readText(f);
    if (!/\buseRuntimeContext\b/.test(code)) continue;
    code = code.replace(
      /import\s*\{([^}]*)\buseRuntimeContext\b([^}]*)\}\s*from\s*['"]@modern-js\/runtime['"]\s*;?/,
      (_, a, b) => {
        const rest = `${a}${b}`
          .replace(/,\s*,/g, ',')
          .replace(/^\s*,|,\s*$/g, '')
          .trim();
        const runtimeImport = rest
          ? `import { ${rest.replace(/\s+/g, ' ')}, RuntimeContext } from '@modern-js/runtime';`
          : `import { RuntimeContext } from '@modern-js/runtime';`;
        return `import { use } from 'react';\n${runtimeImport}`;
      },
    );
    code = code.replace(
      /\buseRuntimeContext\s*\(\s*\)/g,
      'use(RuntimeContext)',
    );
    fs.writeFileSync(f, code);
    hit.push(path.basename(f));
  }
  if (hit.length)
    note(changed, `useRuntimeContext → use(RuntimeContext)：${hit.join(', ')}`);
}

// ---- 6) pages → routes ----
function migratePagesToRoutes(dir) {
  const src = path.join(dir, 'src');
  if (exists(src, 'pages') && !exists(src, 'routes')) {
    fs.renameSync(path.join(src, 'pages'), path.join(src, 'routes'));
    note(changed, 'src/pages → src/routes（约定式路由）');
  } else if (exists(src, 'pages')) {
    note(manual, 'src/pages 与 src/routes 并存：需人工合并');
  }
}

// ---- 7) tailwind postcss ----
function writePostcss(dir, hadTailwind) {
  if (!hadTailwind) return;
  const file = path.join(dir, 'postcss.config.cjs');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      `module.exports = {\n  plugins: {\n    tailwindcss: {},\n  },\n};\n`,
    );
    note(changed, '生成 postcss.config.cjs（Tailwind 改 Rsbuild 原生）');
  }
}

// ---- 8) 其余人工项 ----
function flagManual(dir) {
  const configFile = [
    'modern.config.ts',
    'modern.config.js',
    'modern.config.mjs',
  ].find(f => exists(dir, f));
  const configText = configFile ? readText(path.join(dir, configFile)) : '';
  if (exists(dir, 'server', 'index.ts') || exists(dir, 'server', 'index.js')) {
    note(
      manual,
      '自定义 Web Server：server/index.ts→modern.server.ts + Hono Context + 必须 next()（见 references/migrate-custom-server.md）',
    );
  }
  if (/appIcon\s*:\s*['"]/.test(configText)) {
    note(manual, 'html.appIcon 字符串 → 对象 { icons:[{src,size}] }');
  }
  if (/\bssr\b/.test(configText)) {
    note(
      manual,
      'SSR mode 默认 string→stream：React17 项目需手动设回 "string"',
    );
  }
  if (/\bwebpack\b|webpackChain/.test(configText)) {
    note(manual, 'webpack 自定义配置 → 确认 Rspack 兼容');
  }
}

function main() {
  const args = process.argv.slice(2);
  const dir = path.resolve(args.find(a => !a.startsWith('--')) || '.');
  const toArg = args.find(a => a.startsWith('--to='));
  const toVersion = toArg ? toArg.split('=')[1] : '3.0.0';
  const json = args.includes('--json');

  if (!exists(dir, 'package.json')) {
    console.error(`未找到 package.json: ${dir}`);
    process.exit(1);
  }

  migrateDeps(dir, toVersion);
  const files = collectSources(path.join(dir, 'src'))
    .concat(collectSources(path.join(dir, 'server')))
    .concat(collectSources(path.join(dir, 'api')));
  migrateImportPaths(files);
  const hadTailwind = migrateConfig(dir);
  migrateEntry(dir);
  // entry/runtime 改完后再扫一次最新文件做 runtime-context
  migrateRuntimeContext(
    collectSources(path.join(dir, 'src')).concat(
      collectSources(path.join(dir, 'api')),
    ),
  );
  migratePagesToRoutes(dir);
  writePostcss(dir, hadTailwind);
  flagManual(dir);

  const report = { projectDir: dir, toVersion, changed, manual };
  const outDir = path.join(dir, '.agents', 'runs', 'modernjs-migrate');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`🚚 Modern.js v2→v3 自动迁移：${dir}`);
  console.log(`\n✅ 已自动改写 ${changed.length} 项：`);
  for (const c of changed) console.log(`  - ${c}`);
  console.log(`\n🔴 人工清单 ${manual.length} 项：`);
  for (const m of manual) console.log(`  - ${m}`);
  console.log(
    '\n下一步：pnpm install → modern build；按人工清单处理复杂项。报告见 .agents/runs/modernjs-migrate/report.json',
  );
}

main();
