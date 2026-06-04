#!/usr/bin/env node
// 在一个**已有的 Modern.js v3 应用**里启用可选功能（手动等价于已废弃的 `modern new`）。
//   node scripts/enable.mjs <feature> <projectDir> [--json]
// 第一版仅实现 BFF 完整闭环（依据当前 v3 文档 guides/advanced-features/bff.mdx +
// components/enable-bff.mdx）。其余功能见 references/*（manual checklist），后续逐个自动化。

import fs from 'node:fs';
import path from 'node:path';
import {
  DEPRECATED,
  REUSABLE_PROTO,
  appendToPluginsArray,
  classifyProject,
  exists,
  extractBalanced,
  findConfigFile,
  importSpecifiers,
  isWorkspaceProto,
  locateConfigObjStart,
  maskCommentsAndStrings,
  readText,
  topLevelProps,
} from './lib.mjs';

const changed = [];
const manual = [];
const note = (list, msg) => list.push(msg);

// 读取 @modern-js/app-tools 的版本/协议，用作新装官方包的版本（官方包统一版本号发布）
function appToolsVersion(pkg) {
  return (
    pkg.devDependencies?.['@modern-js/app-tools'] ??
    pkg.dependencies?.['@modern-js/app-tools'] ??
    null
  );
}

// 1) 依赖：加 @modern-js/plugin-bff。版本协议处理（与 migrate-to-v3 一致）：
//    普通 semver / workspace: / catalog:（名称无关）→ 复用 app-tools 的 spec；
//    link: / file: / portal: / npm:（指向具体包路径/别名）→ 不写、进 manual（否则指错包）。
function addBffDep(dir) {
  const file = path.join(dir, 'package.json');
  const pkg = JSON.parse(readText(file));
  const has =
    pkg.dependencies?.['@modern-js/plugin-bff'] ||
    pkg.devDependencies?.['@modern-js/plugin-bff'];
  if (has) return;
  const ver = appToolsVersion(pkg);
  if (ver == null) {
    note(
      manual,
      '未找到 @modern-js/app-tools 版本：请手动安装与之同版本的 @modern-js/plugin-bff',
    );
    return;
  }
  const verStr = String(ver).trim();
  // 指向具体路径/别名的协议不能照搬给别的包
  if (isWorkspaceProto(verStr) && !REUSABLE_PROTO.test(verStr)) {
    note(
      manual,
      `@modern-js/app-tools 用 ${verStr.split(':')[0]}: 协议（指向具体包路径/别名，无法照搬给别的包）：请手动添加 @modern-js/plugin-bff 的正确依赖协议`,
    );
    return;
  }
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies['@modern-js/plugin-bff'] = ver;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  const hint = isWorkspaceProto(verStr) ? ver : `${ver}（与 app-tools 一致）`;
  note(changed, `依赖：添加 @modern-js/plugin-bff@${hint}`);
}

// 2) modern.config：import bffPlugin + 追加到顶层 plugins（复用 migrate-to-v3 的健壮逻辑）
function addBffPluginToConfig(dir) {
  const configFile = findConfigFile(dir);
  if (!configFile) {
    note(manual, '未找到 modern.config.*：请手动在 plugins 里加 bffPlugin()');
    return;
  }
  const file = path.join(dir, configFile);
  let code = readText(file);

  // 已启用：plugins 已有 bffPlugin() 调用 → 跳过（幂等）
  if (/\bbffPlugin\s*\(/.test(maskCommentsAndStrings(code))) return;

  // 识别已有 @modern-js/plugin-bff import（单/双引号、alias）
  const importMatch = code.match(
    /import\s*\{([^}]*)\}\s*from\s*['"]@modern-js\/plugin-bff['"]/,
  );
  let localName = 'bffPlugin';
  const hasImport = Boolean(importMatch);
  if (importMatch) {
    const aliasMatch = importMatch[1].match(/\bbffPlugin\b(?:\s+as\s+(\w+))?/);
    if (!aliasMatch) {
      note(
        manual,
        '已 import @modern-js/plugin-bff 但未导入 bffPlugin，请手动把 bffPlugin() 加进 plugins',
      );
      return;
    }
    localName = aliasMatch[1] || 'bffPlugin';
  }
  if (!hasImport) {
    code = code.replace(
      /(import[^\n]*\n)/,
      `$1import { bffPlugin } from '@modern-js/plugin-bff';\n`,
    );
  }

  const masked = maskCommentsAndStrings(code);
  const objStart = locateConfigObjStart(code, masked);
  if (objStart === -1) {
    note(
      manual,
      '无法定位顶层配置对象（defineConfig/module.exports/export default），请手动把 bffPlugin() 加进顶层 plugins',
    );
    return;
  }
  const obj = extractBalanced(code, objStart, masked);
  if (!obj) {
    note(
      manual,
      'modern.config 解析失败，请手动把 bffPlugin() 加进顶层 plugins',
    );
    return;
  }
  const props = topLevelProps(obj.body);
  const pluginsIdx = props.findIndex(p => /^plugins\s*:/.test(p));
  let newProps;
  if (pluginsIdx !== -1) {
    const appended = appendToPluginsArray(props[pluginsIdx], `${localName}()`);
    if (!appended) {
      note(manual, 'modern.config 顶层 plugins 解析失败，请手动加 bffPlugin()');
      return;
    }
    newProps = props.map((p, i) => (i === pluginsIdx ? appended : p));
  } else {
    // 无 plugins：确保 appTools()（v3 必备）+ bffPlugin()
    const hasAppTools = /\bappTools\b/.test(code);
    if (!hasAppTools) {
      note(
        manual,
        '配置缺少 plugins/appTools：请手动改为 plugins: [appTools(), bffPlugin()]',
      );
      return;
    }
    newProps = [`plugins: [appTools(), ${localName}()]`, ...props];
  }
  const newObj = `{\n  ${newProps.join(',\n  ')},\n}`;
  code = code.slice(0, objStart) + newObj + code.slice(obj.end);
  fs.writeFileSync(file, code);
  note(changed, `配置 ${configFile}：plugins 追加 bffPlugin()`);
}

// 3) tsconfig：加 @api/* 路径别名 + include 加 api（依据 components/enable-bff.mdx）
function patchTsconfig(dir) {
  const tsconfigPath = path.join(dir, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return;
  const raw = readText(tsconfigPath);
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    note(
      manual,
      'tsconfig.json 含注释/非标准 JSON，未自动改：请手动加 paths["@api/*"]=["./api/lambda/*"] 与 include "api"',
    );
    return;
  }
  let touched = false;
  json.compilerOptions = json.compilerOptions || {};
  json.compilerOptions.paths = json.compilerOptions.paths || {};
  if (!json.compilerOptions.paths['@api/*']) {
    json.compilerOptions.paths['@api/*'] = ['./api/lambda/*'];
    touched = true;
  }
  json.include = json.include || [];
  if (!json.include.includes('api')) {
    json.include.push('api');
    touched = true;
  }
  if (touched) {
    fs.writeFileSync(tsconfigPath, `${JSON.stringify(json, null, 2)}\n`);
    note(changed, 'tsconfig.json：添加 @api/* 别名与 api include');
  }
}

// 4) scaffold：api/lambda 示例函数（仅在 api/ 不存在时）
function scaffoldBffApi(dir) {
  const apiDir = path.join(dir, 'api');
  if (fs.existsSync(apiDir)) {
    note(manual, '已存在 api/ 目录：请确认 BFF 函数结构，未覆盖任何文件');
    return;
  }
  const lambdaDir = path.join(apiDir, 'lambda');
  fs.mkdirSync(lambdaDir, { recursive: true });
  const tmpl = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    '..',
    'templates',
    'bff',
    'api',
    'lambda',
    'index.ts',
  );
  const content = fs.existsSync(tmpl)
    ? readText(tmpl)
    : "export default async () => {\n  return { message: 'Hello Modern.js BFF' };\n};\n";
  fs.writeFileSync(path.join(lambdaDir, 'index.ts'), content);
  note(changed, 'scaffold：api/lambda/index.ts 示例 BFF 函数');
}

function enableBff(dir) {
  const configFile = findConfigFile(dir);
  const alreadyEnabled =
    configFile &&
    /\bbffPlugin\s*\(/.test(
      maskCommentsAndStrings(readText(path.join(dir, configFile))),
    ) &&
    importSpecifiers(readText(path.join(dir, configFile))).includes(
      '@modern-js/plugin-bff',
    );
  if (alreadyEnabled) {
    note(manual, 'BFF 似乎已启用（config 已有 bffPlugin()），未重复改写');
    return;
  }
  addBffDep(dir);
  addBffPluginToConfig(dir);
  patchTsconfig(dir);
  scaffoldBffApi(dir);
}

const FEATURES = {
  bff: { run: enableBff, label: 'BFF（一体化后端）' },
};

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter(a => !a.startsWith('--'));
  const feature = positional[0];
  const dir = path.resolve(positional[1] || '.');
  const json = args.includes('--json');

  if (!feature || !FEATURES[feature]) {
    console.error(
      `用法：node scripts/enable.mjs <feature> <projectDir>\n当前自动化支持：${Object.keys(FEATURES).join(', ')}\n其它功能见 references/*（manual checklist）`,
    );
    process.exit(1);
  }
  if (!exists(dir, 'package.json')) {
    console.error(`未找到 package.json: ${dir}`);
    process.exit(1);
  }

  // v3 自保护（不依赖 scan）：v2 / workspace+v2信号 / 非 app-tools → 中止，**不改任何文件**
  const cls = classifyProject(dir);
  if (cls.state !== 'v3') {
    console.error(
      [
        `⛔ 已中止（未改写任何文件）：${cls.reason}`,
        cls.state === 'v2' ? '（feature-enable 仅用于 Modern.js v3 应用）' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    process.exit(1);
  }

  FEATURES[feature].run(dir);

  const report = {
    projectDir: dir,
    feature,
    changed,
    manual,
    deprecated: DEPRECATED,
  };
  const outDir = path.join(dir, '.agents', 'runs', 'modernjs-feature-enable');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`🔧 启用功能：${FEATURES[feature].label}（${dir}）`);
  console.log(`\n✅ 已自动改写 ${changed.length} 项：`);
  for (const c of changed) console.log(`  - ${c}`);
  console.log(`\n🔴 人工清单 ${manual.length} 项：`);
  for (const m of manual) console.log(`  - ${m}`);
  console.log(
    '\n下一步：pnpm install → modern dev/build；在 api/lambda 下编写 BFF 函数，前端直接 import 调用。报告见 .agents/runs/modernjs-feature-enable/report.json',
  );
}

main();
