#!/usr/bin/env node
// 在一个**已有的 Modern.js v3 应用**里启用可选功能（手动等价于已废弃的 `modern new`）。
//   node scripts/enable.mjs <feature> <projectDir> [--json]
// 已自动化：bff、ssg（依据当前 v3 文档 components/enable-bff.mdx / enable-ssg.mdx）。
// 其余功能见 references/other-features.md（manual checklist），后续逐个自动化。
// CJS（module.exports/require）配置插入 require 绑定；插不进/定位不到一律进 manual，不写半成品。

import fs from 'node:fs';
import path from 'node:path';
import {
  DEPRECATED,
  FEATURE_CATALOG,
  REUSABLE_PROTO,
  appendToPluginsArray,
  classifyProject,
  ensureNamedImport,
  exists,
  extractBalanced,
  findConfigFile,
  hasOutputSsg,
  isPluginEnabled,
  isWorkspaceProto,
  locateConfigObjStart,
  maskCommentsAndStrings,
  outputSsgState,
  readText,
  topLevelPluginsHasCall,
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

// 1) 依赖：加官方包 @modern-js/<pkg>。版本协议处理（与 migrate-to-v3 一致）：
//    普通 semver / workspace: / catalog:（名称无关）→ 复用 app-tools 的 spec；
//    link: / file: / portal: / npm:（指向具体包路径/别名）→ 不写、进 manual（否则指错包）。
function addModernDep(dir, pkgName) {
  const file = path.join(dir, 'package.json');
  const pkg = JSON.parse(readText(file));
  if (pkg.dependencies?.[pkgName] || pkg.devDependencies?.[pkgName]) return;
  const ver = appToolsVersion(pkg);
  if (ver == null) {
    note(
      manual,
      `未找到 @modern-js/app-tools 版本：请手动安装与之同版本的 ${pkgName}`,
    );
    return;
  }
  const verStr = String(ver).trim();
  if (isWorkspaceProto(verStr) && !REUSABLE_PROTO.test(verStr)) {
    note(
      manual,
      `@modern-js/app-tools 用 ${verStr.split(':')[0]}: 协议（指向具体包路径/别名，无法照搬给别的包）：请手动添加 ${pkgName} 的正确依赖协议`,
    );
    return;
  }
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies[pkgName] = ver;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  const hint = isWorkspaceProto(verStr) ? ver : `${ver}（与 app-tools 一致）`;
  note(changed, `依赖：添加 ${pkgName}@${hint}`);
}

// 2) modern.config：import <pluginName> + 追加到顶层 plugins（复用 migrate-to-v3 的健壮逻辑）。
//    幂等：plugins 已有该 plugin() 调用则跳过；alias / 已有 import 都正确处理。
function addPluginToConfig(dir, { importPkg, pluginName }) {
  const configFile = findConfigFile(dir);
  if (!configFile) {
    note(
      manual,
      `未找到 modern.config.*：请手动在 plugins 里加 ${pluginName}()`,
    );
    return;
  }
  const file = path.join(dir, configFile);
  let code = readText(file);
  const original = code;

  // **先确保绑定**（ESM import 或 CJS require，含 alias，仅认真实语句），拿不到就 manual、绝不写半成品
  const ens = ensureNamedImport(code, importPkg, pluginName);
  if (ens.manual) {
    note(manual, ens.manual);
    return;
  }
  code = ens.code;
  const localName = ens.localName;

  // 用解析出的**本地名**判断顶层 plugins 是否已调用（alias 感知，限定顶层 plugins）
  const callPresent = topLevelPluginsHasCall(code, localName);

  // 已调用：此前可能缺绑定，本次已补 → 落盘绑定修复（不重复加调用，保证幂等）
  if (callPresent) {
    if (code !== original) {
      fs.writeFileSync(file, code);
      note(
        changed,
        `配置 ${configFile}：补齐 ${pluginName} 的 import/require（plugins 已调用，绑定原缺失）`,
      );
    }
    return;
  }

  const masked = maskCommentsAndStrings(code);
  const objStart = locateConfigObjStart(code, masked);
  if (objStart === -1) {
    note(
      manual,
      `无法定位顶层配置对象（defineConfig/module.exports/export default），请手动把 ${pluginName}() 加进顶层 plugins`,
    );
    return;
  }
  const obj = extractBalanced(code, objStart, masked);
  if (!obj) {
    note(
      manual,
      `modern.config 解析失败，请手动把 ${pluginName}() 加进顶层 plugins`,
    );
    return;
  }
  const props = topLevelProps(obj.body);
  const pluginsIdx = props.findIndex(p => /^plugins\s*:/.test(p));
  let newProps;
  if (pluginsIdx !== -1) {
    const appended = appendToPluginsArray(props[pluginsIdx], `${localName}()`);
    if (!appended) {
      note(
        manual,
        `modern.config 顶层 plugins 解析失败，请手动加 ${pluginName}()`,
      );
      return;
    }
    newProps = props.map((p, i) => (i === pluginsIdx ? appended : p));
  } else {
    const hasAppTools = /\bappTools\b/.test(masked);
    if (!hasAppTools) {
      note(
        manual,
        `配置缺少 plugins/appTools：请手动改为 plugins: [appTools(), ${localName}()]`,
      );
      return;
    }
    newProps = [`plugins: [appTools(), ${localName}()]`, ...props];
  }
  const newObj = `{\n  ${newProps.join(',\n  ')},\n}`;
  code = code.slice(0, objStart) + newObj + code.slice(obj.end);
  fs.writeFileSync(file, code);
  note(changed, `配置 ${configFile}：plugins 追加 ${pluginName}()`);
}

// 2b) modern.config：合并 `output: { ssg: true }`（顶层 output 已存在则只补 ssg，不覆盖）。
function setOutputSsg(dir) {
  const configFile = findConfigFile(dir);
  if (!configFile) return;
  const file = path.join(dir, configFile);
  const code = readText(file);
  const masked = maskCommentsAndStrings(code);
  const objStart = locateConfigObjStart(code, masked);
  if (objStart === -1) {
    note(manual, '无法定位配置对象：请手动设置 output.ssg = true');
    return;
  }
  const obj = extractBalanced(code, objStart, masked);
  if (!obj) {
    note(manual, 'modern.config 解析失败：请手动设置 output.ssg = true');
    return;
  }
  const props = topLevelProps(obj.body);
  // 结构化解析 output 顶层 ssg 状态（不吃字符串/注释/嵌套字段）
  const st = outputSsgState(code);
  let newProps;
  let noteMsg = `配置 ${configFile}：output 合并 ssg: true`;
  if (st.state === 'no-output') {
    newProps = [...props, 'output: { ssg: true }'];
  } else if (st.state === 'output-not-object') {
    note(
      manual,
      'output 值不是对象字面量（动态表达式/函数调用等）：请手动设置 output.ssg = true',
    );
    return;
  } else if (st.state === 'ssg-dynamic') {
    note(
      manual,
      'output.ssg 是动态/无法静态确认的值：请手动确认是否启用 SSG（应为 true 或对象）',
    );
    return;
  } else if (st.state === 'ssg-invalid') {
    note(
      manual,
      'output.ssg 是数组等非法字面量（类型应为 boolean | object）：请手动修正为 true 或对象',
    );
    return;
  } else if (st.state === 'byEntries-enabling' || st.state === 'ssg-enabling') {
    note(
      manual,
      `已配置 output.${st.state === 'byEntries-enabling' ? 'ssgByEntries（已有入口启用）' : 'ssg（true/对象）'}：未覆盖，请确认是否符合 SSG 预期`,
    );
    return;
  } else if (st.state === 'byEntries-off') {
    note(
      manual,
      'output.ssgByEntries 非空但所有入口均为非启用值：请手动开启所需入口，或改用 output.ssg = true（非空 ssgByEntries 会优先于顶层 ssg）',
    );
    return;
  } else if (st.state === 'byEntries-dynamic') {
    note(
      manual,
      'output.ssgByEntries 含动态/无法静态确认的值：请手动确认是否已按预期启用所需入口',
    );
    return;
  } else {
    // 'ssg-off'（false/undefined/null/0/'' → 翻 true）或 'none'（新增顶层 ssg）：重建 output 顶层属性
    const outProps = st.outProps.slice();
    if (st.state === 'ssg-off') {
      outProps[st.ssgIdx] = 'ssg: true';
      noteMsg = `配置 ${configFile}：output.ssg 非启用值 → true（按启用意图）`;
    } else {
      outProps.push('ssg: true');
    }
    const newOutProp = `output: { ${outProps.join(', ')} }`;
    newProps = props.map((p, i) => (i === st.outIdx ? newOutProp : p));
  }
  const newObj = `{\n  ${newProps.join(',\n  ')},\n}`;
  const next = code.slice(0, objStart) + newObj + code.slice(obj.end);
  fs.writeFileSync(file, next);
  note(changed, noteMsg);
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

// 通用：加一个非 @modern-js 依赖（如 tailwindcss / styled-components 的 peer），幂等。新增即记 changed。
function addDep(dir, name, version, dev = true) {
  const file = path.join(dir, 'package.json');
  const pkg = JSON.parse(readText(file));
  if (pkg.dependencies?.[name] || pkg.devDependencies?.[name]) return false;
  const field = dev ? 'devDependencies' : 'dependencies';
  pkg[field] = pkg[field] || {};
  pkg[field][name] = version;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  note(changed, `依赖：添加 ${name}@${version}`);
  return true;
}

// tsconfig include 增加目录（幂等；JSONC/非标准 JSON → manual）
function ensureTsconfigInclude(dir, entry) {
  const tsconfigPath = path.join(dir, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return;
  let json;
  try {
    json = JSON.parse(readText(tsconfigPath));
  } catch {
    note(manual, `tsconfig.json 非标准 JSON：请手动把 "${entry}" 加进 include`);
    return;
  }
  json.include = json.include || [];
  if (!json.include.includes(entry)) {
    json.include.push(entry);
    fs.writeFileSync(tsconfigPath, `${JSON.stringify(json, null, 2)}\n`);
    note(changed, `tsconfig.json：include 增加 "${entry}"`);
  }
}

// 4) BFF 端到端示例：真实 api 函数（export const get）+ 前端页面调用（依据 bff/function.mdx）
const BFF_API_HELLO = "export const get = async () => 'Hello Modern.js';\n";
// 仅 Modern.js generator 默认模板首页才可安全替换：用其签名短语「Get started by editing」判定
// （自定义的 "Welcome to my app" 等不应命中——否则会覆盖用户首页；不确定就走 bff-demo 路由）。
const DEFAULT_PAGE_MARKERS = /Get started by editing/;

function bffExamplePage(importPath, fn) {
  const imp =
    fn === 'default'
      ? `import hello from '${importPath}';`
      : `import { ${fn} as hello } from '${importPath}';`;
  return `import { useEffect, useState } from 'react';
${imp}

export default function Page() {
  const [text, setText] = useState('');

  useEffect(() => {
    hello().then(setText);
  }, []);

  return <div>{text}</div>;
}
`;
}

// 探测/创建真实 BFF api 函数，返回 { importPath, fn }（fn 为导出名或 'default'）。已有文件一律不覆盖。
function ensureBffApi(dir) {
  const lambdaDir = path.join(dir, 'api', 'lambda');
  const reGet = /export\s+const\s+get\b/;
  const reDefault = /export\s+default\b/;
  if (fs.existsSync(lambdaDir)) {
    const walk = d =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
        const p = path.join(d, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
    const files = walk(lambdaDir).filter(
      f => /\.(ts|tsx|js|jsx)$/.test(f) && !f.endsWith('.d.ts'),
    );
    // 注意：tsconfig alias 是 `@api/*` → `./api/lambda/*`，**裸 `@api` 不匹配该模式**。
    // 因此 index.* 也要用显式 `@api/index`（不能裁成 `@api`），否则 import 解析不到。
    const relImport = f => {
      const rel = path
        .relative(lambdaDir, f)
        .replace(/\.(ts|tsx|js|jsx)$/, '')
        .split(path.sep)
        .join('/');
      return `@api/${rel}`;
    };
    // 优先复用 hello.* 的 get，其次任一 get，再次任一 default
    const hello = files.find(f =>
      /(^|\/)hello\.[tj]sx?$/.test(f.replace(/\\/g, '/')),
    );
    if (hello && reGet.test(readText(hello))) {
      note(manual, '复用已有 api/lambda/hello（export get），未覆盖');
      return { importPath: relImport(hello), fn: 'get' };
    }
    const anyGet = files.find(f => reGet.test(readText(f)));
    if (anyGet) {
      note(
        manual,
        `复用已有 BFF 函数 ${path.relative(lambdaDir, anyGet)}（export get），未覆盖`,
      );
      return { importPath: relImport(anyGet), fn: 'get' };
    }
    const anyDefault = files.find(f => reDefault.test(readText(f)));
    if (anyDefault) {
      note(
        manual,
        `复用已有 BFF 函数 ${path.relative(lambdaDir, anyDefault)}（default export），未覆盖`,
      );
      return { importPath: relImport(anyDefault), fn: 'default' };
    }
    // 已有 api 但无可复用函数：创建不冲突的示例（不覆盖任何文件）
    const target = fs.existsSync(path.join(lambdaDir, 'hello.ts'))
      ? path.join(lambdaDir, 'bff-demo.ts')
      : path.join(lambdaDir, 'hello.ts');
    fs.writeFileSync(target, BFF_API_HELLO);
    const name = path.basename(target).replace(/\.ts$/, '');
    note(
      changed,
      `已有 api/ 但无可复用函数：新建 api/lambda/${name}.ts（未改动你已有 API）`,
    );
    return { importPath: `@api/${name}`, fn: 'get' };
  }
  fs.mkdirSync(lambdaDir, { recursive: true });
  fs.writeFileSync(path.join(lambdaDir, 'hello.ts'), BFF_API_HELLO);
  note(changed, 'scaffold：api/lambda/hello.ts（export const get）BFF 函数');
  return { importPath: '@api/hello', fn: 'get' };
}

// 把 BFF 调用示例接进项目真实页面：默认模板首页可安全替换则替换，否则新建 bff-demo 路由；已有 @api 引用则幂等跳过。
function wireBffExample(dir, api) {
  const routesDir = path.join(dir, 'src', 'routes');
  const example = bffExamplePage(api.importPath, api.fn);
  const pageFile = ['page.tsx', 'page.jsx']
    .map(f => path.join(routesDir, f))
    .find(fs.existsSync);
  if (pageFile) {
    const content = readText(pageFile);
    if (/@api\//.test(content)) {
      note(manual, 'src/routes/page 已引用 @api/*：未重复改写（幂等）');
      return;
    }
    if (DEFAULT_PAGE_MARKERS.test(content)) {
      fs.writeFileSync(pageFile, example);
      note(
        changed,
        `已把 BFF 调用示例接入首页 ${path.relative(dir, pageFile)}（原为默认模板页）`,
      );
      return;
    }
    const demo = path.join(routesDir, 'bff-demo', 'page.tsx');
    if (fs.existsSync(demo)) {
      note(manual, 'src/routes/bff-demo/page.tsx 已存在：未覆盖（幂等）');
      return;
    }
    fs.mkdirSync(path.dirname(demo), { recursive: true });
    fs.writeFileSync(demo, example);
    note(
      changed,
      '已有自定义首页未改动；新建 BFF 示例页 src/routes/bff-demo/page.tsx（访问路径 /bff-demo）',
    );
    return;
  }
  if (fs.existsSync(routesDir)) {
    fs.writeFileSync(path.join(routesDir, 'page.tsx'), example);
    note(changed, '生成首页 src/routes/page.tsx 并接入 BFF 调用示例');
    return;
  }
  note(
    manual,
    `项目未使用约定式路由 src/routes/：请手动在页面中加入 BFF 调用示例：\n${example}`,
  );
}

// 读 config 文本（无 config 返回空串）
function readConfig(dir) {
  const configFile = findConfigFile(dir);
  return configFile ? readText(path.join(dir, configFile)) : '';
}

function enableBff(dir) {
  // 插件部分幂等：已启用则不重复改 config；但 api/前端示例仍按需补齐（也各自幂等）
  if (isPluginEnabled(readConfig(dir), '@modern-js/plugin-bff', 'bffPlugin')) {
    note(
      manual,
      'BFF 插件似乎已启用（绑定 + bffPlugin() 调用都在），未重复改写 config',
    );
  } else {
    addModernDep(dir, '@modern-js/plugin-bff');
    addPluginToConfig(dir, {
      importPkg: '@modern-js/plugin-bff',
      pluginName: 'bffPlugin',
    });
  }
  patchTsconfig(dir);
  // 端到端示例：真实 api 函数 + 前端页面调用
  const api = ensureBffApi(dir);
  wireBffExample(dir, api);
}

function enableStyledComponents(dir) {
  // 插件部分幂等：已有则不重复改 config；但 peer 始终确保（半启用态：有插件缺 peer 也要补，否则缺库）
  if (
    isPluginEnabled(
      readConfig(dir),
      '@modern-js/plugin-styled-components',
      'styledComponentsPlugin',
    )
  ) {
    note(manual, 'styled-components 插件已在 config，未重复改写');
  } else {
    addModernDep(dir, '@modern-js/plugin-styled-components');
    addPluginToConfig(dir, {
      importPkg: '@modern-js/plugin-styled-components',
      pluginName: 'styledComponentsPlugin',
    });
  }
  // peer styled-components（^5.3.1，插件 peerDependencies）：不论插件是否已在，缺则补（addDep 幂等）
  addDep(dir, 'styled-components', '^5.3.1', false);
}

// Tailwind CSS：v3 不再是 @modern-js 插件，走 Rsbuild 现行口径（guides/basic-features/css/tailwindcss.mdx）。
// 默认按 Tailwind v3 落地；v4 为可选分支（report 注明）。各步骤幂等、已有文件不覆盖。
function enableTailwind(dir) {
  addDep(dir, 'tailwindcss', '^3.4.17');
  addDep(dir, 'postcss', '^8.4.47');
  addDep(dir, 'autoprefixer', '^10.4.20');
  const twConfig = [
    'tailwind.config.ts',
    'tailwind.config.js',
    'tailwind.config.cjs',
    'tailwind.config.mjs',
  ].find(f => exists(dir, f));
  if (!twConfig) {
    fs.writeFileSync(
      path.join(dir, 'tailwind.config.ts'),
      `import type { Config } from 'tailwindcss';\n\nexport default {\n  content: ['./src/**/*.{ts,tsx,js,jsx,html}'],\n  theme: { extend: {} },\n  plugins: [],\n} satisfies Config;\n`,
    );
    note(changed, '生成 tailwind.config.ts（content 指向 ./src）');
  } else {
    note(manual, `已存在 ${twConfig}：未覆盖，请确认 content 覆盖 ./src`);
  }
  const postcss = [
    'postcss.config.cjs',
    'postcss.config.js',
    'postcss.config.mjs',
    'postcss.config.ts',
  ].find(f => exists(dir, f));
  if (!postcss) {
    fs.writeFileSync(
      path.join(dir, 'postcss.config.cjs'),
      'module.exports = {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n};\n',
    );
    note(changed, '生成 postcss.config.cjs（tailwindcss + autoprefixer）');
  } else {
    note(manual, `已存在 ${postcss}：请确认含 tailwindcss 插件`);
  }
  const twcss = path.join(dir, 'src', 'tailwind.css');
  if (!fs.existsSync(twcss)) {
    fs.writeFileSync(
      twcss,
      '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n',
    );
    note(changed, '生成 src/tailwind.css（@tailwind 指令）');
  }
  note(
    manual,
    "Tailwind 收尾（人工/语义）：在入口或页面 import './tailwind.css'（或给现有全局 CSS 加 @tailwind 指令）；若用 Tailwind v4，改用 @tailwindcss/postcss + 在 CSS 写 @import 'tailwindcss'（见 guides/basic-features/css/tailwindcss.mdx 链接的 Rsbuild 文档）",
  );
}

// 自定义 Web Server：可生成可构建骨架（server-runtime + server/modern.server.ts + tsconfig include），
// 但业务 middleware/render 语义需人工补（不声称已迁好）。幂等：已有 modern.server 不覆盖。
function enableServer(dir) {
  addModernDep(dir, '@modern-js/server-runtime');
  const serverDir = path.join(dir, 'server');
  const existing = ['modern.server.ts', 'modern.server.js']
    .map(f => path.join(serverDir, f))
    .find(fs.existsSync);
  if (existing) {
    note(manual, `已存在 ${path.relative(dir, existing)}：未覆盖（幂等）`);
  } else {
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(serverDir, 'modern.server.ts'),
      "import { defineServerConfig } from '@modern-js/server-runtime';\n\n// 自定义 Web Server 骨架（可构建）。按需添加 middlewares / renderMiddlewares。\n// 业务中间件与渲染逻辑需人工补全，见 references/other-features.md 与 guides/upgrade/web-server。\nexport default defineServerConfig({});\n",
    );
    note(
      changed,
      '生成 server/modern.server.ts（可构建骨架，空 defineServerConfig）',
    );
  }
  ensureTsconfigInclude(dir, 'server');
  note(
    manual,
    '自定义 Server 业务语义需人工补全：middlewares / renderMiddlewares / Hono Context（见 references/other-features.md、guides/upgrade/web-server）',
  );
}

// 需架构决策、暂不自动化的能力：输出可执行 checklist + 原因（不 unsupported、不静默假启用）
const MANUAL_PLANS = {
  microFrontend: {
    label: '微前端（Module Federation / masterApp）',
    reason:
      'v3 已无 @modern-js/plugin-garfish；微前端是主/子应用拓扑的架构决策（基座、子应用清单、路由分发），自动化会改坏语义。',
    checklist: [
      '确定拓扑：主应用（masterApp）/ 子应用，以及通信与路由分发方式',
      '主应用：在 src/modern.runtime.ts 配 masterApp（apps 列表，见 components/micro-master-manifest-config.mdx）',
      '子应用：暴露入口、配置 manifest（见 components/micro-runtime-config.mdx）',
      '依据现行文档 components/micro-frontend.mdx 选择 Module Federation / Garfish 运行时方案',
    ],
  },
};

function enableSsg(dir) {
  // SSG 双条件：ssgPlugin 真实绑定+调用 **且** output.ssg/ssgByEntries。两者都在才算已启用
  const code = readConfig(dir);
  const pluginOn = isPluginEnabled(code, '@modern-js/plugin-ssg', 'ssgPlugin');
  if (pluginOn && hasOutputSsg(code)) {
    const via =
      outputSsgState(code).state === 'byEntries-enabling'
        ? 'output.ssgByEntries（已有入口启用）'
        : 'output.ssg';
    note(manual, `SSG 似乎已启用（ssgPlugin() + ${via} 都在），未重复改写`);
    return;
  }
  // 半启用（缺 plugin 或缺 output.ssg）都继续补齐——各子步骤幂等
  addModernDep(dir, '@modern-js/plugin-ssg');
  addPluginToConfig(dir, {
    importPkg: '@modern-js/plugin-ssg',
    pluginName: 'ssgPlugin',
  });
  setOutputSsg(dir);
}

const FEATURES = {
  bff: { run: enableBff, label: 'BFF（一体化后端）' },
  ssg: { run: enableSsg, label: '静态站点生成 SSG' },
  'styled-components': {
    run: enableStyledComponents,
    label: 'styled-components（CSS-in-JS）',
  },
  tailwindcss: {
    run: enableTailwind,
    label: 'Tailwind CSS（v3，Rsbuild 原生）',
  },
  server: { run: enableServer, label: '自定义 Web Server（骨架）' },
};

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter(a => !a.startsWith('--'));
  const feature = positional[0];
  const dir = path.resolve(positional[1] || '.');
  const json = args.includes('--json');

  const plan = MANUAL_PLANS[feature];
  if (!feature || !(FEATURES[feature] || plan)) {
    console.error(
      [
        '用法：node scripts/enable.mjs <feature> <projectDir>',
        `可执行（自动 / 骨架）：${Object.keys(FEATURES).join(', ')}`,
        `需架构决策（输出 checklist，不会改文件）：${Object.keys(MANUAL_PLANS).join(', ')}`,
        '先跑 scan.mjs 看完整能力矩阵。',
      ].join('\n'),
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

  const label = FEATURES[feature]?.label || plan.label;
  if (FEATURES[feature]) {
    FEATURES[feature].run(dir);
  } else {
    // 需架构决策：输出可执行 checklist + 原因（不 unsupported、不静默假启用、不改文件）
    note(manual, `${plan.label} 暂不自动化（需架构决策）：${plan.reason}`);
    plan.checklist.forEach((c, i) => note(manual, `  [${i + 1}] ${c}`));
  }

  const catalogTier = FEATURE_CATALOG.find(f => f.key === feature)?.tier;
  const report = {
    projectDir: dir,
    feature,
    featureLabel: label,
    // tier 来自能力矩阵：auto（完整启用）/ scaffold（骨架已生成 + 语义待人工，非完整）/ manual（仅 checklist）
    tier: catalogTier || (FEATURES[feature] ? 'auto' : 'manual'),
    complete: catalogTier === 'auto',
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
  console.log(`🔧 启用功能：${label}（${dir}）`);
  console.log(`\n✅ 已自动改写 ${changed.length} 项：`);
  for (const c of changed) console.log(`  - ${c}`);
  console.log(`\n🔴 人工清单 ${manual.length} 项：`);
  for (const m of manual) console.log(`  - ${m}`);
  const nextHint =
    feature === 'bff'
      ? 'api/lambda/hello.ts(export const get) + 前端页面已 import 调用，modern dev 后访问页面可见 BFF 返回'
      : feature === 'ssg'
        ? 'modern build 会预渲染为静态 HTML（可在 output.ssg 细化按入口/路由）'
        : feature === 'tailwindcss'
          ? "记得 import './tailwind.css' 后再用 class"
          : feature === 'server'
            ? 'server/modern.server.ts 为骨架，按需补 middlewares/renderMiddlewares'
            : '按对应 reference / checklist 完成后续配置';
  console.log(
    `\n下一步：pnpm install → modern dev/build；${nextHint}。报告见 .agents/runs/modernjs-feature-enable/report.json`,
  );
}

main();
