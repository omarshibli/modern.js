#!/usr/bin/env node
// 扫描一个 Modern.js 项目，判定可迁移性并产出迁移上下文。
//   node scripts/scan-project.mjs <projectDir>
// 产出 <projectDir>/.agents/runs/modernjs-migrate/context.json
//
// 规则：调用方显式传入 projectDir；脚本只校验该目录，不向上猜测。
// 仅识别信号、不改代码。阻断条件（非 v2/v3、Node 过低）直接失败并说明原因。

import fs from 'node:fs';
import path from 'node:path';

const MIN_NODE = [18, 20, 8];
const SRC_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.agents',
  'coverage',
]);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
const readText = file => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const exists = (...p) => fs.existsSync(path.join(...p));
const majorOf = v => {
  const m = String(v ?? '').match(/(\d+)/);
  return m ? Number(m[1]) : null;
};
function parseVersion(raw) {
  const m = String(raw ?? '')
    .replace(/^v/, '')
    .match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}
const cmp = (a, b) => {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
};

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

function fail(reasons) {
  throw new Error(
    ['scan-project failed:', ...reasons.map(r => `- ${r}`)].join('\n'),
  );
}

function detectConfigFile(dir) {
  for (const f of [
    'modern.config.ts',
    'modern.config.js',
    'modern.config.mjs',
  ]) {
    if (exists(dir, f)) return f;
  }
  return null;
}

// src/pages 约定式路由（v3 不支持），无同级 App.tsx / routes 时判定需迁移
function hasPagesDir(dir) {
  const src = path.join(dir, 'src');
  return (
    exists(src, 'pages') &&
    !exists(src, 'routes') &&
    !exists(src, 'App.tsx') &&
    !exists(src, 'App.jsx')
  );
}

function main() {
  const projectDir = path.resolve(process.argv[2] ?? process.cwd());
  if (!exists(projectDir, 'package.json')) {
    fail([`传入目录不是合法 projectDir：${projectDir}（缺少 package.json）`]);
  }
  const pkg = readJson(path.join(projectDir, 'package.json'));
  if (!pkg) fail(['package.json 解析失败']);

  const deps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };
  const appToolsVersion = deps['@modern-js/app-tools'] ?? null;
  const appToolsMajor = majorOf(appToolsVersion);
  // monorepo 协议（workspace:* / link: / catalog: / * 等）无法解析出主版本号，
  // 但仍是 Modern.js 项目（v2 分支 integration fixture 即如此），不应阻断
  const WORKSPACE_PROTO = /^(workspace:|link:|file:|catalog:|portal:|npm:|\*$)/;
  const isWorkspaceVersion =
    appToolsVersion != null &&
    WORKSPACE_PROTO.test(String(appToolsVersion).trim());
  const configFile = detectConfigFile(projectDir);
  const configText = configFile
    ? readText(path.join(projectDir, configFile))
    : '';

  // 阻断判断
  const blocking = [];
  if (appToolsMajor !== 2 && appToolsMajor !== 3 && !isWorkspaceVersion) {
    blocking.push(
      `当前项目不是可识别的 Modern.js v2/v3 项目，检测到 @modern-js/app-tools = ${appToolsVersion ?? 'missing'}`,
    );
  }
  const node = parseVersion(process.version);
  if (!node || cmp(node, MIN_NODE) < 0) {
    blocking.push(
      `Node.js 版本不足：当前 ${process.version}，要求 >= ${MIN_NODE.join('.')}`,
    );
  }
  if (blocking.length) fail(blocking);

  const files = collectSources(path.join(projectDir, 'src'))
    .concat(collectSources(path.join(projectDir, 'server')))
    .concat(collectSources(path.join(projectDir, 'api')));
  const rel = f => path.relative(projectDir, f);
  const grep = re => files.filter(f => re.test(readText(f))).map(rel);

  const src = path.join(projectDir, 'src');
  // 入口类型
  const entryType = exists(src, 'routes')
    ? 'routes'
    : exists(src, 'App.tsx') || exists(src, 'App.jsx')
      ? 'app'
      : exists(src, 'index.tsx') || exists(src, 'index.jsx')
        ? 'custom-index'
        : 'unknown';

  const features = {
    // 路由
    'pages-to-routes': hasPagesDir(projectDir),
    // 入口
    'custom-entry': entryType === 'custom-index',
    'app-config': grep(/\bApp\.config\b/),
    'app-init': grep(/\bApp\.init\b/),
    'layout-config-init': grep(/export\s+const\s+(config|init)\b/),
    // import 路径映射
    'import-bff': grep(/@modern-js\/runtime\/bff\b/),
    'import-server': grep(/@modern-js\/runtime\/server\b/),
    // runtime API
    'use-runtime-context': grep(/\buseRuntimeContext\b/),
    // 配置
    'dev-port': /\bdev\s*:\s*\{[\s\S]*?\bport\b/.test(configText),
    'app-icon-string': /appIcon\s*:\s*['"]/.test(configText),
    'ssr-mode': /\bssr\b/.test(configText),
    'tailwind-plugin':
      Boolean(deps['@modern-js/plugin-tailwindcss']) ||
      /plugin-tailwindcss|tailwindcssPlugin/.test(configText),
    'webpack-config':
      /\bwebpack\b/.test(configText) ||
      grep(/\bwebpackChain\b|tools\.webpack/).length > 0,
    // 自定义 server
    'custom-server':
      exists(projectDir, 'server', 'index.ts') ||
      exists(projectDir, 'server', 'index.js'),
  };

  const modernDeps = Object.fromEntries(
    Object.entries(deps).filter(([n]) => n.startsWith('@modern-js/')),
  );

  const context = {
    projectDir,
    // 无法解析主版本（workspace 协议）时按 v2 待迁移处理（迁移最安全的默认）
    migrationState:
      appToolsMajor === 3
        ? 'v3'
        : appToolsMajor === 2 || isWorkspaceVersion
          ? 'v2'
          : 'v2',
    appToolsVersion,
    configFile,
    entryType,
    node: process.version,
    modernDeps,
    features,
  };

  const outDir = path.join(projectDir, '.agents', 'runs', 'modernjs-migrate');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'context.json');
  fs.writeFileSync(outFile, `${JSON.stringify(context, null, 2)}\n`);

  const enabled = Object.entries(features)
    .filter(([, v]) => (Array.isArray(v) ? v.length : v))
    .map(([k]) => k);
  console.log(`projectDir: ${projectDir}`);
  console.log(
    `appTools: ${appToolsVersion ?? 'missing'} (${context.migrationState})`,
  );
  console.log(`entry: ${entryType}   node: ${process.version}`);
  console.log(`features: ${enabled.length ? enabled.join(', ') : 'none'}`);
  console.log(`context: ${outFile}`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
