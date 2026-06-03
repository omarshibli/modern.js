#!/usr/bin/env node
// 对一个 Modern.js v2 项目执行**可安全自动化**的 v2→v3 改写，并把复杂项列入人工清单。
//   node scripts/migrate.mjs <projectDir> [--to=<version>] [--json]
//
// 自动改写（依据 guides/upgrade/*）：
//   - 依赖：@modern-js/* 统一升到目标版本；移除 @modern-js/plugin-tailwindcss
//   - import 路径：runtime/bff→plugin-bff/runtime、runtime/server→server-runtime
//   - 配置：appTools({ bundler })→appTools()；顶层 runtime 块→合并进空的 src/modern.runtime.ts；
//           dev.port→server.port；移除 tailwind 插件 import/调用 + 写 postcss.config.cjs
//   - 入口：src/index.* → src/entry.*（bootstrap 函数改写为 createRoot/render）
//   - App.config → src/modern.runtime.ts 的 defineRuntimeConfig
//   - useRuntimeContext() → use/useContext(RuntimeContext)（保留 react default import；alias 进人工）
//   - src/pages → src/routes（无 routes 时）
// 人工清单（语义复杂，不自动）：App.init / layout init、自定义 server、html.appIcon、
//   server.ssr.mode、webpack 自定义配置、modernConfig.runtime、非空/函数式 runtime、
//   applyBaseConfig(...) 包装下的结构性迁移（integration helper，标注「结构迁移未完成」）。

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

// monorepo / 非语义化版本协议：随 monorepo 整体升级解析，不该被改写成固定版本号
const WORKSPACE_PROTO = /^(workspace:|link:|catalog:|file:|portal:|npm:|\*$)/;
const isWorkspaceProto = v =>
  v != null && WORKSPACE_PROTO.test(String(v).trim());

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

// 把注释（//、/* */）和字符串/模板字面量的**内容**替换为等长空白（保留换行、引号、长度
// 与字符索引 1:1）。所有结构定位（配置对象、括号配平、顶层逗号、信号匹配）都基于 masked，
// 但真实内容仍按相同索引从原文取——避免注释/字符串里的 defineConfig({...}) / { } / 逗号 误导。
function maskCommentsAndStrings(code) {
  let out = '';
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i];
    const c2 = code[i + 1];
    if (c === '/' && c2 === '/') {
      out += '  ';
      i += 2;
      while (i < n && code[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        out += code[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n && code[i] !== quote) {
        if (code[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        out += code[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += quote;
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// 只剥离注释、**保留字符串原样**（等长），用于需要字符串「值」的判断（如 ssr.mode: 'string'）。
// 字符串内的 // 不当注释处理。
function maskComments(code) {
  let out = '';
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i];
    const c2 = code[i + 1];
    if (c === '/' && c2 === '/') {
      out += '  ';
      i += 2;
      while (i < n && code[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        out += code[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n && code[i] !== quote) {
        if (code[i] === '\\') {
          out += code[i] + (code[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += code[i];
        i += 1;
      }
      if (i < n) {
        out += quote;
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// 提取真正的模块 specifier（import x from '...'、export ... from '...'、import '...'、
// import('...')、require('...')）。逐字符扫描：跳过注释，遇到字符串时回看前一个 token 是否
// 为 import/from/require( 才算 specifier——避免在普通字符串文本里裸搜包名造成误判。
function importSpecifiers(code) {
  const specs = [];
  const n = code.length;
  let i = 0;
  let acc = ''; // 最近的代码片段（不含注释/字符串），用于判定字符串是否处于 import 位置
  while (i < n) {
    const c = code[i];
    const c2 = code[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && code[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      let content = '';
      while (j < n && code[j] !== quote) {
        if (code[j] === '\\') {
          content += code[j + 1] ?? '';
          j += 2;
          continue;
        }
        content += code[j];
        j += 1;
      }
      // 前一个 token 是 from / import / require( / import( 时，本字符串才是模块 specifier
      if (/(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\()\s*$/.test(acc)) {
        specs.push(content);
      }
      i = j + 1;
      acc = '';
      continue;
    }
    acc += c;
    if (acc.length > 32) acc = acc.slice(-32);
    i += 1;
  }
  return specs;
}

// 取对象字面量 `{...}` 的顶层属性片段（忽略嵌套/注释/字符串），用于只识别顶层字段
function topLevelProps(body) {
  const inner = body.slice(1, -1);
  const masked = maskCommentsAndStrings(inner); // 与 inner 等长，定位用
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

// 从 `{` 处做花括号配平（忽略注释/字符串里的花括号），返回对象字面量文本与结束位置。
// 配平基于 masked，body 仍取原文。
function extractBalanced(text, startIdx, maskedText) {
  const masked = maskedText ?? maskCommentsAndStrings(text);
  let depth = 0;
  for (let i = startIdx; i < text.length; i++) {
    const c = masked[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { body: text.slice(startIdx, i + 1), end: i + 1 };
    }
  }
  return null;
}

// 定位顶层配置对象字面量的起始 `{` 下标，兼容：
//   defineConfig({  /  defineConfig<'rspack'>({  /  export default {  /  module.exports = {
// 在 masked（注释/字符串已剥离）上匹配，索引对原文有效。
// 函数式/动态（defineConfig(() => ({...}))）返回 -1，交调用方走 manual。
function locateConfigObjStart(code, maskedText) {
  const masked = maskedText ?? maskCommentsAndStrings(code);
  const dcObj = masked.match(/defineConfig\s*(?:<[^>]*>)?\s*\(\s*\{/);
  if (dcObj) return dcObj.index + dcObj[0].length - 1;
  const ed = masked.match(/export\s+default\s*\{/);
  if (ed) return ed.index + ed[0].length - 1;
  const me = masked.match(/module\.exports\s*=\s*\{/);
  if (me) return me.index + me[0].length - 1;
  return -1;
}

// 把 bffPlugin() **追加到** 顶层 plugins 数组末尾（保留原插件顺序，避免插到 appTools 之前）
function appendToPluginsArray(prop, call) {
  const arrStart = prop.indexOf('[');
  if (arrStart === -1) return null;
  let depth = 0;
  let arrEnd = -1;
  for (let i = arrStart; i < prop.length; i++) {
    if (prop[i] === '[') depth += 1;
    else if (prop[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        arrEnd = i;
        break;
      }
    }
  }
  if (arrEnd === -1) return null;
  // 去掉尾随逗号（如 tailwind 移除后残留的 `appTools(), `），避免 append 后出现双逗号
  const inner = prop
    .slice(arrStart + 1, arrEnd)
    .trim()
    .replace(/,\s*$/, '');
  const newInner = inner ? `${inner}, ${call}` : call;
  return `${prop.slice(0, arrStart)}[${newInner}]${prop.slice(arrEnd + 1)}`;
}

// ---- 1) 依赖 ----
function migrateDeps(dir, toVersion) {
  const file = path.join(dir, 'package.json');
  const pkg = JSON.parse(readText(file));
  let bumped = false;
  let tailwindRemoved = false;
  const skippedWorkspace = new Set();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[field];
    if (!deps) continue;
    if (deps['@modern-js/plugin-tailwindcss']) {
      delete deps['@modern-js/plugin-tailwindcss'];
      tailwindRemoved = true;
    }
    for (const name of Object.keys(deps)) {
      if (!name.startsWith('@modern-js/')) continue;
      // workspace/link/catalog 协议：随 monorepo 升级，不改成固定版本（否则破坏 workspace 链接）
      if (isWorkspaceProto(deps[name])) {
        skippedWorkspace.add(name);
        continue;
      }
      if (deps[name] !== toVersion) {
        deps[name] = toVersion;
        bumped = true;
      }
    }
  }
  if (bumped || tailwindRemoved) {
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
    const parts = [];
    if (bumped) parts.push(`@modern-js/* 升到 ${toVersion}`);
    if (tailwindRemoved) parts.push('移除 @modern-js/plugin-tailwindcss');
    note(changed, `依赖：${parts.join('，')}`);
  }
  if (skippedWorkspace.size) {
    note(
      manual,
      `workspace/link/catalog 协议依赖未改版本（随 monorepo 整体升级到 v3）：${[...skippedWorkspace].join(', ')}`,
    );
  }
}

// ---- 2) import 路径映射 ----
function migrateImportPaths(files) {
  const map = [
    ['@modern-js/runtime/bff', '@modern-js/plugin-bff/runtime', 'bff'],
    ['@modern-js/runtime/server', '@modern-js/server-runtime', 'server'],
  ];
  const hit = [];
  const flags = { bff: false, server: false };
  for (const f of files) {
    let code = readText(f);
    let c = false;
    for (const [from, to, flag] of map) {
      if (code.includes(from)) {
        code = code.split(from).join(to);
        c = true;
        flags[flag] = true;
      }
    }
    if (c) {
      fs.writeFileSync(f, code);
      hit.push(path.basename(f));
    }
  }
  if (hit.length) note(changed, `import 路径映射：${hit.join(', ')}`);
  return flags;
}

// import 改到新包后，补充对应依赖，否则 install/build 失败。版本协议处理：
//   - 普通 semver：用 toVersion
//   - workspace: / catalog:（**名称无关**协议，由 key 决定包）：复用现有 app-tools/runtime 的 spec
//   - link: / file: / portal: / npm:（**指向具体包路径/别名**）：不能把 app-tools 的目标写给别的包，
//     否则会指错路径 → 不写依赖，进 manual 提示手动添加正确协议
function ensureMappedDeps(dir, toVersion, flags) {
  const verOf = (pkg, name) =>
    pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
  const file = path.join(dir, 'package.json');
  const pkg = JSON.parse(readText(file));
  pkg.dependencies = pkg.dependencies || {};
  // 参考协议：优先 app-tools，其次 runtime
  const refVer =
    verOf(pkg, '@modern-js/app-tools') ?? verOf(pkg, '@modern-js/runtime');
  const refStr = refVer == null ? '' : String(refVer).trim();
  // 名称无关、可安全复用的协议
  const reusable = /^(workspace:|catalog:)/.test(refStr);
  // 指向具体路径/别名、不可复用的协议（虽在保留范围内，但不能照搬给别的包）
  const pathPinned = !reusable && isWorkspaceProto(refStr);
  const addVer = reusable ? refStr : toVersion;
  const added = [];
  const manualAdd = [];
  const want = (flag, name) => {
    if (!flag || verOf(pkg, name) != null) return;
    if (pathPinned) {
      manualAdd.push(name);
      return;
    }
    pkg.dependencies[name] = addVer;
    added.push(name);
  };
  want(flags.bff, '@modern-js/plugin-bff');
  want(flags.server, '@modern-js/server-runtime');
  if (added.length) {
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
    note(changed, `补充依赖（${addVer}）：${added.join(', ')}`);
  }
  if (manualAdd.length) {
    note(
      manual,
      `现有 @modern-js 依赖用 ${refStr.split(':')[0]}: 协议（指向具体包路径/别名，无法照搬给别的包）：请手动添加 ${manualAdd.join(', ')} 的正确依赖协议`,
    );
  }
}

// 启用 BFF 后，modern.config 需 import 并加入 bffPlugin()
function addBffPlugin(dir, flags) {
  if (!flags.bff) return;
  const configFile = [
    'modern.config.ts',
    'modern.config.js',
    'modern.config.mjs',
  ].find(f => exists(dir, f));
  if (!configFile) return;
  const file = path.join(dir, configFile);
  let code = readText(file);

  // applyBaseConfig 包装的配置（integration helper / 非标准用户配置）：结构性改写交人工，
  // 统一由 migrateRuntimeBlock 记 manual，这里直接跳过，避免半自动改坏顶层 plugins
  if (/\bapplyBaseConfig\s*\(/.test(maskCommentsAndStrings(code))) return;

  // 识别已有 @modern-js/plugin-bff import（单/双引号皆可），取 bffPlugin 的本地名（含 alias）
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
  // 已经调用了对应插件就跳过
  if (new RegExp(`\\b${localName}\\s*\\(`).test(code)) return;
  // 没有 import 才补一行（避免重复 import 造成 duplicate identifier）
  if (!hasImport) {
    code = code.replace(
      /(import[^\n]*\n)/,
      `$1import { bffPlugin } from '@modern-js/plugin-bff';\n`,
    );
  }
  // v3 顶层 plugins 必含 appTools()；若未 import 但能在 @modern-js/app-tools import 上补则补，
  // 补不了（无 app-tools import）就进 manual 且不写半成品 plugins
  let hasAppTools = /\bappTools\b/.test(code);
  if (!hasAppTools) {
    const appToolsImp = code.match(
      /import\s*\{([^}]*)\}\s*from\s*['"]@modern-js\/app-tools['"]/,
    );
    if (appToolsImp) {
      const ns = appToolsImp[1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      ns.unshift('appTools');
      code = code.replace(
        appToolsImp[0],
        `import { ${ns.join(', ')} } from '@modern-js/app-tools'`,
      );
      hasAppTools = true;
      note(changed, '配置：在 @modern-js/app-tools import 上补 appTools');
    }
  }
  // 只改顶层 plugins（避免误命中 tools.postcss.postcssOptions.plugins 等嵌套）
  const objStart = locateConfigObjStart(code);
  if (objStart === -1) {
    note(
      manual,
      '无法定位顶层配置对象（defineConfig/module.exports/export default），请手动把 bffPlugin() 加进顶层 plugins',
    );
    return;
  }
  const obj = extractBalanced(code, objStart);
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
    // 追加到 plugins 末尾（保留原顺序，得到 [..., bffPlugin()] 而非前插）
    const appended = appendToPluginsArray(props[pluginsIdx], `${localName}()`);
    if (!appended) {
      note(
        manual,
        'modern.config 顶层 plugins 解析失败，请手动把 bffPlugin() 加进 plugins',
      );
      return;
    }
    newProps = props.map((p, i) => (i === pluginsIdx ? appended : p));
    if (!/\bappTools\s*\(/.test(newProps[pluginsIdx])) {
      note(
        manual,
        'modern.config 顶层 plugins 缺少 appTools()，请按 v3 模板补上',
      );
    }
  } else if (!hasAppTools) {
    // 无 plugins 数组且无法补 appTools import：不写半成品，交人工
    note(
      manual,
      'BFF 已启用但无法定位/补充 appTools import：请手动添加 plugins: [appTools(), bffPlugin()]',
    );
    return;
  } else {
    newProps = [`plugins: [appTools(), ${localName}()]`, ...props];
  }
  const newObj = newProps.length ? `{\n  ${newProps.join(',\n  ')},\n}` : '{}';
  code = code.slice(0, objStart) + newObj + code.slice(obj.end);

  if (new RegExp(`${localName}\\s*\\(\\s*\\)`).test(newObj)) {
    fs.writeFileSync(file, code);
    note(changed, '配置：添加 bffPlugin()');
  } else {
    note(
      manual,
      'BFF 已启用但无法自动写入 modern.config 顶层 plugins，请手动加 bffPlugin()',
    );
  }
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

  // applyBaseConfig 包装：dev.port 这类结构性迁移交人工（由 migrateRuntimeBlock 统一记 manual），
  // 这里只做 tailwind 等安全的文本级移除
  const wrapped = /\bapplyBaseConfig\s*\(/.test(maskCommentsAndStrings(code));

  // dev.port -> server.port：只移动 port，保留 dev 块其余配置；解析不了则进人工清单
  const devMatch = wrapped ? null : code.match(/\bdev\s*:\s*\{/);
  if (devMatch) {
    const block = extractBalanced(
      code,
      devMatch.index + devMatch[0].length - 1,
    );
    if (!block) {
      note(manual, 'dev 块解析失败：dev.port 需人工迁到 server.port');
    } else {
      // 只识别**顶层** dev.port；嵌套（如 dev.client.port）不动
      const props = topLevelProps(block.body);
      const portIdx = props.findIndex(p => /^['"]?port['"]?\s*:/.test(p));
      if (portIdx !== -1) {
        const port = props[portIdx]
          .slice(props[portIdx].indexOf(':') + 1)
          .trim();
        const rest = props.filter((_, i) => i !== portIdx);
        const devReplacement = rest.length ? `dev: { ${rest.join(', ')} }` : '';
        code =
          code.slice(0, devMatch.index) +
          devReplacement +
          code.slice(block.end);
        if (!devReplacement) code = code.replace(/,(\s*[,)\]\n])/, '$1');
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
        note(changed, 'dev.port → server.port');
      }
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
    if (hadTailwind) note(changed, `配置 ${configFile}：移除 tailwind 插件`);
  }
  return hadTailwind;
}

// 从 `appTools(...)` 调用里**只删 bundler 参数**（v3 默认 Rspack，不再接受 bundler），
// 保留其它选项与别的 plugin 参数；返回 {code, changed}
function stripAppToolsBundler(code) {
  const masked = maskCommentsAndStrings(code);
  const m = masked.match(/\bappTools\s*\(/);
  if (!m) return { code, changed: false };
  const open = m.index + m[0].length - 1; // '(' 的下标
  let depth = 0;
  let close = -1;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return { code, changed: false };
  const argText = code.slice(open + 1, close).trim();
  if (!argText.startsWith('{')) return { code, changed: false }; // 空参/函数式 → 不动
  const props = topLevelProps(argText);
  const kept = props.filter(p => !/^['"]?bundler['"]?\s*:/.test(p));
  if (kept.length === props.length) return { code, changed: false }; // 无 bundler
  const newArg = kept.length ? `{ ${kept.join(', ')} }` : '';
  return {
    code: code.slice(0, open + 1) + newArg + code.slice(close),
    changed: true,
  };
}

// 把 runtime 配置对象合并进 src/modern.runtime.ts。
// 返回 'created'（新建）| 'ok'（合并进空的 defineRuntimeConfig({})）| 'conflict'（已有非空配置，需人工）
function mergeIntoRuntime(dir, rtValue) {
  const src = path.join(dir, 'src');
  if (!fs.existsSync(src)) fs.mkdirSync(src, { recursive: true });
  const rtFile = [
    'modern.runtime.ts',
    'modern.runtime.js',
    'modern.runtime.tsx',
  ]
    .map(f => path.join(src, f))
    .find(fs.existsSync);
  if (!rtFile) {
    fs.writeFileSync(
      path.join(src, 'modern.runtime.ts'),
      [
        `import { defineRuntimeConfig } from '@modern-js/runtime';`,
        '',
        `export default defineRuntimeConfig(${rtValue});`,
        '',
      ].join('\n'),
    );
    return 'created';
  }
  let code = readText(rtFile);
  // 仅当现有是空的 defineRuntimeConfig({}) 时才安全合并；否则交人工
  const empty = code.match(/defineRuntimeConfig\(\s*\{\s*\}\s*\)/);
  if (empty) {
    code = code.replace(empty[0], `defineRuntimeConfig(${rtValue})`);
    fs.writeFileSync(rtFile, code);
    return 'ok';
  }
  return 'conflict';
}

// ---- 3b) v2 主路径配置：appTools({ bundler }) → appTools()；顶层 runtime 块 → modern.runtime.ts ----
// v3 不再支持在 modern.config 配 runtime（见 guides/upgrade/entry），必须迁到 modern.runtime.ts
function migrateRuntimeBlock(dir) {
  const configFile = [
    'modern.config.ts',
    'modern.config.js',
    'modern.config.mjs',
  ].find(f => exists(dir, f));
  if (!configFile) return;
  const file = path.join(dir, configFile);
  let code = readText(file);
  let touched = false;

  // applyBaseConfig 是仓库 integration 测试 helper / 非标准用户配置包装：结构性迁移
  // （runtime / plugins / dev.port / appTools bundler）一律交人工，避免半自动改坏。
  // 文件级安全改写（依赖升级 / import 路径 / tailwind 移除）仍由其它步骤完成。
  // 检测一律在 masked（剥离注释/字符串）上做，避免注释里的 applyBaseConfig/runtime 误触发。
  if (/\bapplyBaseConfig\s*\(/.test(maskCommentsAndStrings(code))) {
    note(
      manual,
      '⚠️ 结构迁移未完成：modern.config 用 applyBaseConfig(...)（integration 测试 helper / 非标准配置包装）包裹。runtime / plugins / dev.port / appTools({ bundler }) 等结构性迁移需先人工展开为 defineConfig 再处理；本次仅完成依赖升级 / import 路径 / tailwind 等文件级安全改写，配置结构尚未迁移到 v3。',
    );
    return;
  }

  // (a) appTools({ bundler }) → appTools()
  const at = stripAppToolsBundler(code);
  if (at.changed) {
    code = at.code;
    touched = true;
    note(changed, '配置：appTools({ bundler }) → appTools()（v3 默认 Rspack）');
  }

  // (b) 顶层 runtime 块 → modern.runtime.ts
  // locateConfigObjStart 兼容 defineConfig({ / defineConfig<...>({ / export default { / module.exports = {
  const masked = maskCommentsAndStrings(code);
  const objStart = locateConfigObjStart(code, masked);
  if (objStart === -1) {
    // 函数式 / 动态 defineConfig(() => ({...}))：runtime 无法安全静态搬运
    if (/\bruntime\s*:/.test(masked)) {
      note(
        manual,
        'modern.config 使用函数式/动态配置且含 runtime：需人工迁到 modern.runtime.ts（见 references/migrate-entry.md）',
      );
    }
    if (touched) fs.writeFileSync(file, code);
    return;
  }
  const obj = extractBalanced(code, objStart, masked);
  if (!obj) {
    if (touched) fs.writeFileSync(file, code);
    return;
  }
  const props = topLevelProps(obj.body);
  const rtIdx = props.findIndex(p => /^runtime\s*:/.test(p));
  if (rtIdx === -1) {
    if (touched) fs.writeFileSync(file, code);
    return;
  }
  const rtProp = props[rtIdx];
  const rtValue = rtProp.slice(rtProp.indexOf(':') + 1).trim();
  if (!rtValue.startsWith('{')) {
    // runtime 为函数式/非对象字面量 → 人工，保留在 config
    note(
      manual,
      'modern.config 的 runtime 为函数式/非对象：需人工迁到 src/modern.runtime.ts',
    );
    if (touched) fs.writeFileSync(file, code);
    return;
  }
  const merged = mergeIntoRuntime(dir, rtValue);
  if (merged === 'conflict') {
    note(
      manual,
      '已存在非空 src/modern.runtime.ts：modern.config 的 runtime 需人工合并（暂保留在 config，见 references/migrate-entry.md）',
    );
    if (touched) fs.writeFileSync(file, code);
    return;
  }
  // 合并成功才从 config 移除 runtime 块
  const restProps = props.filter((_, i) => i !== rtIdx);
  const newObj = restProps.length
    ? `{\n  ${restProps.join(',\n  ')},\n}`
    : '{}';
  code = code.slice(0, objStart) + newObj + code.slice(obj.end);
  fs.writeFileSync(file, code);
  note(
    changed,
    `modern.config 的 runtime 块 → src/modern.runtime.ts（${merged === 'created' ? '新建' : '合并进空配置'}）`,
  );
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
  const rtExists = fs.existsSync(path.join(src, 'modern.runtime.ts'));
  if (appFile) {
    let code = readText(appFile);
    const cfgMatch = code.match(/App\.config\s*=\s*\{/);
    if (cfgMatch && rtExists) {
      // 已有 modern.runtime.ts：不覆盖，App.config 留给人工合并
      note(
        manual,
        '已存在 src/modern.runtime.ts：App.config 需人工合并进现有 defineRuntimeConfig（不自动覆盖，见 references/migrate-entry.md）',
      );
    } else if (cfgMatch) {
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
function migrateRuntimeContext(files, reactMajor) {
  // React 19+ 用 use(RuntimeContext)；<19（v2 app 常见 17/18）用 useContext，避免生成不可用代码
  const api = reactMajor >= 19 ? 'use' : 'useContext';
  const hit = [];
  const ctxFieldHits = [];
  const aliasHits = [];
  for (const f of files) {
    let code = readText(f);
    if (!/\buseRuntimeContext\b/.test(code)) continue;
    // alias（useRuntimeContext as X）：本地名不确定、调用点改写有歧义，不做文本改写，交人工
    if (/\buseRuntimeContext\s+as\s+\w+/.test(code)) {
      aliasHits.push(path.basename(f));
      continue;
    }
    // 返回值结构变化：isBrowser 移到顶层，context 简化为 request/response（other.md）
    if (/\bcontext\.(isBrowser|logger|metrics)\b/.test(code)) {
      ctxFieldHits.push(path.basename(f));
    }
    // 1) @modern-js/runtime import：去掉 useRuntimeContext，补 RuntimeContext（去重）
    code = code.replace(
      /import\s*\{([^}]*)\}\s*from\s*(['"])@modern-js\/runtime\2\s*;?/,
      (m, specs, q) => {
        if (!/\buseRuntimeContext\b/.test(specs)) return m;
        const names = specs
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
          .filter(n => n !== 'useRuntimeContext');
        if (!names.includes('RuntimeContext')) names.push('RuntimeContext');
        return `import { ${names.join(', ')} } from ${q}@modern-js/runtime${q};`;
      },
    );
    // 2) react import：合并 hook 到已有 react import，没有才新建（避免重复声明）
    //    捕获 default / namespace 前缀（import React, {...} / import * as React, {...}）并保留，
    //    否则会把 default import React 丢掉（项目里 React.memo / <React.Fragment> 会报错）
    const reactImp = code.match(
      /import\s+(?:(\*\s+as\s+[\w$]+|[\w$]+(?:\s+as\s+[\w$]+)?)\s*,\s*)?\{([^}]*)\}\s*from\s*(['"])react\3\s*;?/,
    );
    if (reactImp) {
      const prefix = reactImp[1];
      const names = reactImp[2]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (!names.includes(api)) {
        names.push(api);
        const head = prefix ? `${prefix}, ` : '';
        code = code.replace(
          reactImp[0],
          `import ${head}{ ${names.join(', ')} } from ${reactImp[3]}react${reactImp[3]};`,
        );
      }
    } else {
      code = `import { ${api} } from 'react';\n${code}`;
    }
    // 3) 调用点
    code = code.replace(
      /\buseRuntimeContext\s*\(\s*\)/g,
      `${api}(RuntimeContext)`,
    );
    fs.writeFileSync(f, code);
    hit.push(path.basename(f));
  }
  if (hit.length) {
    note(
      changed,
      `useRuntimeContext → ${api}(RuntimeContext)（React ${reactMajor >= 19 ? '19+' : '<19'}）：${hit.join(', ')}`,
    );
  }
  if (ctxFieldHits.length) {
    note(
      manual,
      `RuntimeContext 返回值结构变化：isBrowser 移到顶层、context 仅含 request/response，需人工调整 context.isBrowser/logger/metrics 用法（见 guides/upgrade/other.md）：${ctxFieldHits.join(', ')}`,
    );
  }
  if (aliasHits.length) {
    note(
      manual,
      `useRuntimeContext 使用了别名（as），未自动改写：请手动改为 ${api}(RuntimeContext)（见 references/migrate-entry.md）：${aliasHits.join(', ')}`,
    );
  }
}

// ---- 6) pages → routes ----
function migratePagesToRoutes(dir) {
  const src = path.join(dir, 'src');
  if (exists(src, 'pages') && !exists(src, 'routes')) {
    fs.renameSync(path.join(src, 'pages'), path.join(src, 'routes'));
    note(changed, 'src/pages → src/routes（约定式路由）');
    // 更新相对引用 ../pages → ../routes；残留（别名等非相对）引用进人工清单
    let rewrote = 0;
    const residual = [];
    for (const f of collectSources(src)) {
      const code = readText(f);
      const updated = code.replace(
        /(['"])((?:\.\.?\/)+)pages(\/[^'"]*)?\1/g,
        (_, q, relPath, tail) => `${q}${relPath}routes${tail || ''}${q}`,
      );
      if (updated !== code) {
        fs.writeFileSync(f, updated);
        rewrote += 1;
      }
      if (
        /(?:from\s+|import\(\s*|require\(\s*)['"][^'"]*\bpages\b[^'"]*['"]/.test(
          updated,
        )
      ) {
        residual.push(path.relative(dir, f));
      }
    }
    if (rewrote) note(changed, `更新 ${rewrote} 处 pages→routes 相对引用`);
    if (residual.length) {
      note(
        manual,
        `仍有 pages 引用需人工核对（别名/非相对路径）：${residual.join(', ')}`,
      );
    }
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
function flagManual(dir, reactMajor) {
  const configFile = [
    'modern.config.ts',
    'modern.config.js',
    'modern.config.mjs',
    'modern.config.cjs',
  ].find(f => exists(dir, f));
  const rawConfig = configFile ? readText(path.join(dir, configFile)) : '';
  // 结构/标识符（appIcon 键、ssr 键、webpack）用 maskCommentsAndStrings，普通字符串不触发；
  // 需要字符串「值」的判断（ssr.mode: 'string'/'stream'）用 maskComments（保留字符串、去注释）
  const configText = maskCommentsAndStrings(rawConfig);
  const configWithStr = maskComments(rawConfig);
  if (exists(dir, 'server', 'index.ts') || exists(dir, 'server', 'index.js')) {
    note(
      manual,
      '自定义 Web Server：server/index.ts→modern.server.ts + Hono Context + 必须 next()（见 references/migrate-custom-server.md）',
    );
  }
  if (/appIcon\s*:\s*['"]/.test(configText)) {
    note(manual, 'html.appIcon 字符串 → 对象 { icons:[{src,size}] }');
  }
  // SSR：v3 默认 stream。只在「显式 string」「React<18 启用 SSR」「模式/版本无法判断」时提示；
  // mode:'stream' + React18+ 是 v3 默认安全形态，不报（避免污染报告边界）
  if (/\bssr\b/.test(configText)) {
    const hasStream = /mode\s*:\s*['"]stream['"]/.test(configWithStr);
    const hasString = /mode\s*:\s*['"]string['"]/.test(configWithStr);
    if (hasString) {
      note(
        manual,
        'server.ssr.mode 显式为 "string"：确认 v3 下是否仍需 string 渲染（默认已改 stream）',
      );
    } else if (!hasStream && reactMajor > 0 && reactMajor < 18) {
      note(
        manual,
        'SSR + React<18：v3 默认 stream 渲染，React17 需手动把 server.ssr.mode 设回 "string"',
      );
    } else if (!hasStream && reactMajor === 0) {
      note(
        manual,
        'SSR 已启用但无法判断 React 版本/渲染模式：确认 server.ssr.mode（v3 默认 stream）',
      );
    }
  }
  if (/\bwebpack\b|webpackChain/.test(configText)) {
    note(manual, 'webpack 自定义配置 → 确认 Rspack 兼容');
  }
  // v2 支持在 package.json 的 modernConfig.runtime 配运行时；v3 必须迁到 modern.runtime.ts
  const pkg = JSON.parse(readText(path.join(dir, 'package.json')));
  if (pkg.modernConfig?.runtime) {
    note(
      manual,
      'package.json 的 modernConfig.runtime 需人工迁到 src/modern.runtime.ts（见 references/migrate-entry.md）',
    );
  }
}

// v2-only 结构信号（v3 不再有）：用于在 workspace 协议下区分 v2 待迁移 vs 已是 v3。
// 明确排除 routes / modern.runtime.ts / appTools()（v3 也有，不算信号）。
function detectV2Signals(dir, pkg) {
  const configFile = [
    'modern.config.ts',
    'modern.config.js',
    'modern.config.mjs',
    'modern.config.cjs',
  ].find(f => exists(dir, f));
  // 结构/标识符信号：用 maskCommentsAndStrings（字符串一并 mask），普通字符串示例文本不算信号。
  // import 信号：单独从真实模块 specifier 提取，不在任意字符串里裸搜包名。
  const configText = configFile
    ? maskCommentsAndStrings(readText(path.join(dir, configFile)))
    : '';
  const deps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };
  const files = collectSources(path.join(dir, 'src'))
    .concat(collectSources(path.join(dir, 'server')))
    .concat(collectSources(path.join(dir, 'api')));
  const anyCode = re =>
    files.some(f => re.test(maskCommentsAndStrings(readText(f))));
  const anyImport = mod =>
    files.some(f => importSpecifiers(readText(f)).some(s => s.startsWith(mod)));
  const signals = [];
  if (/\bruntime\s*:/.test(configText))
    signals.push('modern.config 顶层 runtime');
  if (/appTools\s*\(\s*\{[^)]*\bbundler\b/.test(configText)) {
    signals.push('appTools({ bundler })');
  }
  if (/\bapplyBaseConfig\s*\(/.test(configText))
    signals.push('applyBaseConfig');
  if (
    deps['@modern-js/plugin-tailwindcss'] ||
    /\btailwindcssPlugin\b/.test(configText)
  ) {
    signals.push('plugin-tailwindcss');
  }
  if (anyImport('@modern-js/runtime/bff'))
    signals.push('@modern-js/runtime/bff import');
  if (anyImport('@modern-js/runtime/server')) {
    signals.push('@modern-js/runtime/server import');
  }
  if (anyCode(/\bApp\.config\b/)) signals.push('App.config');
  if (anyCode(/\bApp\.init\b/)) signals.push('App.init');
  if (anyCode(/export\s+const\s+(config|init)\b/))
    signals.push('layout config/init');
  if (anyCode(/\buseRuntimeContext\b/)) signals.push('useRuntimeContext');
  if (exists(dir, 'src', 'pages') && !exists(dir, 'src', 'routes')) {
    signals.push('src/pages');
  }
  if (exists(dir, 'server', 'index.ts') || exists(dir, 'server', 'index.js')) {
    signals.push('自定义 server (server/index)');
  }
  return signals;
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

  const pkg = JSON.parse(readText(path.join(dir, 'package.json')));
  const reactMajor =
    Number(String(pkg.dependencies?.react ?? '').match(/(\d+)/)?.[1]) || 0;

  // 二次保护（不依赖 scan）：workspace/monorepo 协议 + 无任何 v2-only 信号 → ambiguous，
  // 可能已是 v3 workspace 应用，拒绝迁移、不改任何文件
  const appToolsVer =
    pkg.devDependencies?.['@modern-js/app-tools'] ??
    pkg.dependencies?.['@modern-js/app-tools'] ??
    null;
  if (isWorkspaceProto(appToolsVer)) {
    const signals = detectV2Signals(dir, pkg);
    if (!signals.length) {
      console.error(
        [
          '⛔ 迁移已中止（未改写任何文件）：',
          `检测到 @modern-js/app-tools 使用 workspace/monorepo 协议（${appToolsVer}）但无任何 v2-only 信号，`,
          '无法确认这是待迁移的 v2 项目——很可能已经是 v3 workspace 应用。',
          '请人工确认项目确为 v2 后再迁移（先跑 scan-project.mjs 核对）。',
        ].join('\n'),
      );
      process.exit(1);
    }
  }

  migrateDeps(dir, toVersion);
  const files = collectSources(path.join(dir, 'src'))
    .concat(collectSources(path.join(dir, 'server')))
    .concat(collectSources(path.join(dir, 'api')));
  const importFlags = migrateImportPaths(files);
  ensureMappedDeps(dir, toVersion, importFlags);
  const hadTailwind = migrateConfig(dir);
  // runtime 块 → modern.runtime.ts、appTools({ bundler }) → appTools()（applyBaseConfig 走 manual）
  // 须在 migrateEntry 之前：若它新建/填充了 modern.runtime.ts，App.config 抽取会识别为已存在而走 merge/manual
  migrateRuntimeBlock(dir);
  addBffPlugin(dir, importFlags);
  migrateEntry(dir);
  // entry/runtime 改完后再扫一次最新文件做 runtime-context
  migrateRuntimeContext(
    collectSources(path.join(dir, 'src')).concat(
      collectSources(path.join(dir, 'api')),
    ),
    reactMajor,
  );
  migratePagesToRoutes(dir);
  writePostcss(dir, hadTailwind);
  flagManual(dir, reactMajor);

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
