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

// 定位 modern.config 文件
export function findConfigFile(dir) {
  return ['modern.config.ts', 'modern.config.js', 'modern.config.mjs'].find(f =>
    exists(dir, f),
  );
}
