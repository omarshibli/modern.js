// 配置改写公共库（从 modernjs-migrate-to-v3 已收敛实现移植，保证对真实文件的健壮性）。
// 所有结构定位都基于「剥离注释与字符串」后的 masked 文本，改写落原文同索引。

import fs from 'node:fs';
import path from 'node:path';

export const readText = f => fs.readFileSync(f, 'utf8');
export const exists = (...p) => fs.existsSync(path.join(...p));

// 把注释和字符串内容替换为等长空白（保留换行/引号/长度与索引 1:1），用于结构定位
export function maskCommentsAndStrings(code) {
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

// 只剥离注释、保留字符串原样（等长），用于需要字符串「值」（如 import 路径）的匹配
export function maskComments(code) {
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

// 单一扫描器：对每个真实模块 specifier（import/export-from/side-effect/dynamic/require）回调
export function eachModuleSpecifier(code, visit) {
  const n = code.length;
  let i = 0;
  let acc = '';
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
      i = Math.min(i + 2, n);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const open = i;
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
      const close = j;
      let kind = null;
      if (/\bimport\s*\(\s*$/.test(acc)) kind = 'dynamic';
      else if (/\brequire\s*\(\s*$/.test(acc)) kind = 'require';
      else if (/\bfrom\s*$/.test(acc) || /\bimport\s*$/.test(acc))
        kind = 'static';
      if (kind) visit({ content, open, close, quote, kind });
      i = j + 1;
      acc = '';
      continue;
    }
    acc += c;
    if (acc.length > 32) acc = acc.slice(-32);
    i += 1;
  }
}

export function importSpecifiers(code) {
  const specs = [];
  eachModuleSpecifier(code, ({ content }) => specs.push(content));
  return specs;
}

// 对象字面量 `{...}` 顶层属性片段（忽略嵌套/注释/字符串）
export function topLevelProps(body) {
  const inner = body.slice(1, -1);
  const masked = maskCommentsAndStrings(inner);
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

// 从 `{` 处做花括号配平（忽略注释/字符串），返回对象字面量文本与结束位置
export function extractBalanced(text, startIdx, maskedText) {
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

// 定位顶层配置对象起始 `{`：defineConfig({ / defineConfig<...>({ / export default { / module.exports = {
export function locateConfigObjStart(code, maskedText) {
  const masked = maskedText ?? maskCommentsAndStrings(code);
  const dcObj = masked.match(/defineConfig\s*(?:<[^>]*>)?\s*\(\s*\{/);
  if (dcObj) return dcObj.index + dcObj[0].length - 1;
  const ed = masked.match(/export\s+default\s*\{/);
  if (ed) return ed.index + ed[0].length - 1;
  const me = masked.match(/module\.exports\s*=\s*\{/);
  if (me) return me.index + me[0].length - 1;
  return -1;
}

// 把 call 追加到顶层 plugins 数组末尾（保留原顺序、去尾随逗号）
export function appendToPluginsArray(prop, call) {
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
  const inner = prop
    .slice(arrStart + 1, arrEnd)
    .trim()
    .replace(/,\s*$/, '');
  const newInner = inner ? `${inner}, ${call}` : call;
  return `${prop.slice(0, arrStart)}[${newInner}]${prop.slice(arrEnd + 1)}`;
}

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// 确保 code 里有 `name`（来自 importPkg）的命名绑定。已有则返回其本地名；没有则按模块风格
// （ESM import / CJS require）插入一条，插到最后一条 import/require 后、否则文件顶部（跳过开头注释）。
// 返回 { code, localName } 成功 | { manual } 无法可靠处理（不写半成品）。
export function ensureNamedImport(code, importPkg, name) {
  const masked = maskComments(code); // 注释剥离、字符串（含 import 路径）保留
  const pkg = reEsc(importPkg);
  // 已有 ESM import { ... } from 'pkg'
  const esm = masked.match(
    new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${pkg}['"]`),
  );
  if (esm) {
    const m = esm[1].match(new RegExp(`\\b${name}\\b(?:\\s+as\\s+(\\w+))?`));
    if (m) return { code, localName: m[1] || name };
    return {
      manual: `已 import ${importPkg} 但未导入 ${name}：请手动把 ${name} 加进 import 再使用`,
    };
  }
  // 已有 CJS const { ... } = require('pkg')
  const cjs = masked.match(
    new RegExp(
      `(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*require\\(\\s*['"]${pkg}['"]\\s*\\)`,
    ),
  );
  if (cjs) {
    const m = cjs[1].match(new RegExp(`\\b${name}\\b(?:\\s*:\\s*(\\w+))?`));
    if (m) return { code, localName: m[1] || name };
    return {
      manual: `已 require ${importPkg} 但未解构 ${name}：请手动加 ${name} 再使用`,
    };
  }
  // 没有绑定：按模块风格插入。module.exports / (无 ESM import 且有 require) → CJS
  const isCjs =
    /\bmodule\.exports\b/.test(masked) ||
    (!/\bimport\b[^\n]*\bfrom\b/.test(masked) && /\brequire\s*\(/.test(masked));
  const stmt = isCjs
    ? `const { ${name} } = require('${importPkg}');`
    : `import { ${name} } from '${importPkg}';`;
  const lines = code.split('\n');
  const maskedLines = masked.split('\n');
  let lastImp = -1;
  for (let i = 0; i < maskedLines.length; i++) {
    if (
      /^\s*import\b/.test(maskedLines[i]) ||
      /=\s*require\s*\(/.test(maskedLines[i])
    ) {
      lastImp = i;
    }
  }
  let at;
  if (lastImp !== -1) {
    at = lastImp + 1;
  } else {
    at = 0;
    for (let i = 0; i < maskedLines.length; i++) {
      const t = maskedLines[i].trim();
      if (
        t === '' ||
        t.startsWith('//') ||
        t.startsWith('/*') ||
        t.startsWith('*') ||
        t.startsWith('#!')
      ) {
        at = i + 1;
        continue;
      }
      break;
    }
  }
  lines.splice(at, 0, stmt);
  const next = lines.join('\n');
  // 校验确实插入成功
  const verify = ensureNamedImport(next, importPkg, name);
  if (verify.localName) return { code: next, localName: name };
  return {
    manual: `无法自动插入 ${name} 的 import/require：请手动添加后再使用 ${name}()`,
  };
}

// 定位 modern.config 文件
export function findConfigFile(dir) {
  return ['modern.config.ts', 'modern.config.js', 'modern.config.mjs'].find(f =>
    exists(dir, f),
  );
}

// ---- 版本协议（与 migrate-to-v3 收敛逻辑一致）----
// 非语义化协议：不能当固定版本处理
export const WORKSPACE_PROTO =
  /^(workspace:|link:|catalog:|file:|portal:|npm:|\*$)/;
// 名称无关、可安全复用给别的包的协议（由 key 决定包）
export const REUSABLE_PROTO = /^(workspace:|catalog:)/;
export const isWorkspaceProto = v =>
  v != null && WORKSPACE_PROTO.test(String(v).trim());

function collectSources(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (
        !['node_modules', '.git', 'dist', 'build', '.agents'].includes(e.name)
      ) {
        collectSources(full, files);
      }
    } else if (
      /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name) &&
      !e.name.endsWith('.d.ts')
    ) {
      files.push(full);
    }
  }
  return files;
}

// v2-only 结构信号（v3 不再有）。明确排除 routes / modern.runtime.ts / appTools()（v3 也有）。
// 用于在 workspace/link 等非语义版本下区分 v2 待迁移 vs 已是 v3。
export function detectV2Signals(dir) {
  const configFile = findConfigFile(dir) || 'modern.config.cjs';
  const cfgPath = path.join(dir, configFile);
  const configText = fs.existsSync(cfgPath)
    ? maskCommentsAndStrings(readText(cfgPath))
    : '';
  const pkg = exists(dir, 'package.json')
    ? JSON.parse(readText(path.join(dir, 'package.json')))
    : {};
  const deps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };
  const files = collectSources(path.join(dir, 'src'))
    .concat(collectSources(path.join(dir, 'server')))
    .concat(collectSources(path.join(dir, 'api')));
  const anyImport = mod =>
    files.some(f => importSpecifiers(readText(f)).some(s => s.startsWith(mod)));
  const anyCode = re =>
    files.some(f => re.test(maskCommentsAndStrings(readText(f))));
  const signals = [];
  if (/\bruntime\s*:/.test(configText)) signals.push('config.runtime');
  if (/appTools\s*\(\s*\{[^)]*\bbundler\b/.test(configText))
    signals.push('appTools({ bundler })');
  if (/\bapplyBaseConfig\s*\(/.test(configText))
    signals.push('applyBaseConfig');
  if (
    deps['@modern-js/plugin-tailwindcss'] ||
    /\btailwindcssPlugin\b/.test(configText)
  ) {
    signals.push('plugin-tailwindcss');
  }
  if (anyImport('@modern-js/runtime/bff')) signals.push('runtime/bff import');
  if (anyImport('@modern-js/runtime/server'))
    signals.push('runtime/server import');
  if (anyCode(/\bApp\.config\b/)) signals.push('App.config');
  if (anyCode(/\bApp\.init\b/)) signals.push('App.init');
  if (anyCode(/\buseRuntimeContext\b/)) signals.push('useRuntimeContext');
  if (exists(dir, 'src', 'pages') && !exists(dir, 'src', 'routes'))
    signals.push('src/pages');
  if (exists(dir, 'server', 'index.ts') || exists(dir, 'server', 'index.js'))
    signals.push('自定义 server (server/index)');
  return signals;
}

// 判定项目可启用性。返回 { state: 'v2'|'v3'|'unknown', reason, signals, appTools }
export function classifyProject(dir) {
  const pkg = JSON.parse(readText(path.join(dir, 'package.json')));
  const deps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };
  const appTools = deps['@modern-js/app-tools'] ?? null;
  if (appTools == null) {
    return {
      state: 'unknown',
      reason:
        '未检测到 @modern-js/app-tools：feature-enable 仅用于 Modern.js（app-tools）应用',
      signals: [],
      appTools: null,
    };
  }
  const major = Number(String(appTools).match(/(\d+)/)?.[1]);
  if (major === 2) {
    return {
      state: 'v2',
      reason:
        '检测到 Modern.js v2：请先用 modernjs-migrate-to-v3 升级到 v3 再启用功能',
      signals: [],
      appTools,
    };
  }
  if (major === 3) return { state: 'v3', reason: '', signals: [], appTools };
  // 非语义协议（workspace/link/catalog/...）：用 v2-only 信号判定，命中即按 v2 处理
  if (isWorkspaceProto(appTools)) {
    const signals = detectV2Signals(dir);
    if (signals.length) {
      return {
        state: 'v2',
        reason: `检测到 v2-only 信号（${signals.join(', ')}）：请先用 modernjs-migrate-to-v3 升级到 v3 再启用功能`,
        signals,
        appTools,
      };
    }
    return { state: 'v3', reason: '', signals: [], appTools };
  }
  return {
    state: 'unknown',
    reason: `无法判定 Modern.js 版本（@modern-js/app-tools = ${appTools}）：请人工确认为 v3 后再启用`,
    signals: [],
    appTools,
  };
}

// 当前已知的废弃命令（stale doc），供 report/scan 输出，避免引导用户走旧命令
export const DEPRECATED = {
  removedCommands: ['modern new', 'modern upgrade'],
  evidence:
    'guides/upgrade/other.md:107,111 —— Modern.js 3.0 已移除 modern new / modern upgrade，需按文档手动操作',
  staleDocs: [
    'packages/document/docs/{zh,en}/apis/app/commands.mdx 仍残留 `## modern new`，为 stale doc，不可作为现行依据',
  ],
  note: '本 skill 即「按文档手动启用功能」的自动化等价物；不要执行 modern new。',
};
