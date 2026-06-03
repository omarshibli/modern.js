#!/usr/bin/env node
// 验证 modernjs-migrate-to-v3 skill：把 fixtures 复制到临时目录，跑
// scan-project.mjs + migrate.mjs，断言迁移结果符合 v2→v3 文档。
//   node tests/skill/run.mjs
// 退出码非 0 表示有断言失败。覆盖 happy path + 三类真实形态（已有 runtime、
// pages 引用、复杂 dev 块）。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SCRIPTS = path.join(
  REPO,
  'packages/toolkit/skills/catalog/modernjs-migrate-to-v3/scripts',
);
const tmpDirs = [];

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}`);
  }
}

// 复制某个 fixture 到临时目录并跑 migrate；返回读取辅助
function prepare(fixture, runMigrate = true) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-migrate-'));
  tmpDirs.push(work);
  copyDir(path.join(HERE, 'fixtures', fixture), work);
  if (runMigrate) {
    execFileSync(
      'node',
      [path.join(SCRIPTS, 'migrate.mjs'), work, '--to=3.0.0'],
      {
        encoding: 'utf8',
      },
    );
  }
  return {
    work,
    read: rel => fs.readFileSync(path.join(work, rel), 'utf8'),
    has: rel => fs.existsSync(path.join(work, rel)),
    report: () =>
      JSON.parse(
        fs.readFileSync(
          path.join(work, '.agents/runs/modernjs-migrate/report.json'),
          'utf8',
        ),
      ),
  };
}

try {
  // ===== 1) happy path：fixtures/v2-app =====
  console.log('== v2-app (happy path) ==');
  const a = prepare('v2-app', false);
  const scanOut = execFileSync(
    'node',
    [path.join(SCRIPTS, 'scan-project.mjs'), a.work],
    { encoding: 'utf8' },
  );
  check('扫描判定为 v2 项目', /\(v2\)/.test(scanOut));
  execFileSync(
    'node',
    [path.join(SCRIPTS, 'migrate.mjs'), a.work, '--to=3.0.0'],
    { encoding: 'utf8' },
  );

  const pkg = JSON.parse(a.read('package.json'));
  check(
    '@modern-js/app-tools 升到 3.0.0',
    pkg.devDependencies['@modern-js/app-tools'] === '3.0.0',
  );
  check(
    '@modern-js/runtime 升到 3.0.0',
    pkg.dependencies['@modern-js/runtime'] === '3.0.0',
  );
  check(
    '移除 @modern-js/plugin-tailwindcss',
    !pkg.devDependencies['@modern-js/plugin-tailwindcss'],
  );
  check('生成 postcss.config.cjs', a.has('postcss.config.cjs'));

  const cfg = a.read('modern.config.ts');
  check(
    'config 移除 plugin-tailwindcss import',
    !cfg.includes('plugin-tailwindcss'),
  );
  check(
    'config 移除 tailwindcssPlugin() 调用',
    !cfg.includes('tailwindcssPlugin'),
  );
  check(
    'dev.port → server.port（server 含 port: 8080）',
    /server\s*:\s*\{[^}]*port\s*:\s*8080/.test(cfg),
  );
  check('config 不再有 dev: { port }', !/\bdev\s*:\s*\{\s*port/.test(cfg));

  const app = a.read('src/App.tsx');
  check('App.tsx 不再有 App.config', !/\bApp\.config\b/.test(app));
  check('生成 src/modern.runtime.ts', a.has('src/modern.runtime.ts'));
  const rt = a.has('src/modern.runtime.ts')
    ? a.read('src/modern.runtime.ts')
    : '';
  check(
    'modern.runtime.ts 含 defineRuntimeConfig + supportHtml5History',
    /defineRuntimeConfig/.test(rt) && /supportHtml5History/.test(rt),
  );
  check(
    'App.tsx: runtime/bff → plugin-bff/runtime',
    !app.includes('@modern-js/runtime/bff') &&
      app.includes('@modern-js/plugin-bff/runtime'),
  );
  check(
    'server: runtime/server → server-runtime',
    !a.read('server/index.ts').includes('@modern-js/runtime/server') &&
      a.read('server/index.ts').includes('@modern-js/server-runtime'),
  );
  check(
    'React18: useRuntimeContext → useContext(RuntimeContext)',
    !/\buseRuntimeContext\b/.test(app) &&
      app.includes('useContext(RuntimeContext)') &&
      /import\s*\{\s*useContext\s*\}\s*from\s*['"]react['"]/.test(app),
  );
  check(
    '补充 @modern-js/plugin-bff 依赖（import 改到新包）',
    pkg.dependencies['@modern-js/plugin-bff'] === '3.0.0',
  );
  check(
    '补充 @modern-js/server-runtime 依赖',
    pkg.dependencies['@modern-js/server-runtime'] === '3.0.0',
  );
  check(
    'config 加入 bffPlugin()',
    /bffPlugin\(\)/.test(cfg) && cfg.includes('@modern-js/plugin-bff'),
  );
  const manualA = a.report().manual.join('\n');
  check('人工清单含 App.init', /App\.init/.test(manualA));
  check('人工清单含 自定义 server', /modern\.server/.test(manualA));
  check('人工清单含 appIcon', /appIcon/.test(manualA));
  check('人工清单含 ssr', /ssr|SSR/.test(manualA));

  // ===== 2) 已有 modern.runtime.ts + 复杂 dev 块：fixtures/v2-edge-runtime =====
  console.log('== v2-edge-runtime (existing runtime + dev:{port,hmr}) ==');
  const b = prepare('v2-edge-runtime');
  const existingRt = b.read('src/modern.runtime.ts');
  check(
    '已有 modern.runtime.ts 未被覆盖（保留 existingPlugin）',
    existingRt.includes('existingPlugin'),
  );
  check(
    'App.tsx 保留 App.config（未盲目抽取）',
    /\bApp\.config\b/.test(b.read('src/App.tsx')),
  );
  check(
    'App.config 进人工清单',
    /modern\.runtime\.ts/.test(b.report().manual.join('\n')),
  );
  const cfgB = b.read('modern.config.ts');
  check(
    '复杂 dev 块：port 移走但保留 hmr',
    /dev\s*:\s*\{[^}]*hmr/.test(cfgB) && !/dev\s*:\s*\{[^}]*port/.test(cfgB),
  );
  check(
    '复杂 dev 块：server 含 port: 8080',
    /server\s*:\s*\{[^}]*port\s*:\s*8080/.test(cfgB),
  );

  // ===== 3) pages 引用：fixtures/v2-edge-pages =====
  console.log('== v2-edge-pages (pages + import ../pages) ==');
  const c = prepare('v2-edge-pages');
  check('src/pages → src/routes', c.has('src/routes') && !c.has('src/pages'));
  const link = c.read('src/components/Link.tsx');
  check(
    '引用 ../pages → ../routes',
    link.includes('../routes/index') && !link.includes('../pages/index'),
  );
  check(
    '无残留 pages 引用人工项',
    !/pages 引用/.test(c.report().manual.join('\n')),
  );

  // ===== 4) 嵌套 dev.client.port（顶层无 port）：不能误迁 =====
  console.log('== v2-edge-devnested (nested dev.client.port only) ==');
  const dn = prepare('v2-edge-devnested');
  const cfgDn = dn.read('modern.config.ts');
  check(
    '嵌套 client.port 8081 保留（不被误迁）',
    /client\s*:\s*\{[^}]*port\s*:\s*8081/.test(cfgDn),
  );
  check(
    '顶层无 port → 不创建 server.port',
    !/server\s*:\s*\{[^}]*port/.test(cfgDn),
  );

  // ===== 5) 嵌套 client.port + 顶层 port：只迁顶层 =====
  console.log('== v2-edge-devboth (nested client.port + top-level port) ==');
  const db = prepare('v2-edge-devboth');
  const cfgDb = db.read('modern.config.ts');
  check(
    '顶层 dev.port → server.port (8080)',
    /server\s*:\s*\{[^}]*port\s*:\s*8080/.test(cfgDb),
  );
  check(
    '嵌套 client.port 8081 保留',
    /client\s*:\s*\{[^}]*port\s*:\s*8081/.test(cfgDb),
  );

  // ===== 6) React 19：useRuntimeContext → use() =====
  console.log('== v2-edge-react19 (React 19 → use()) ==');
  const r = prepare('v2-edge-react19');
  const appR = r.read('src/App.tsx');
  check(
    'React19: useRuntimeContext → use(RuntimeContext)',
    appR.includes('use(RuntimeContext)') &&
      /import\s*\{\s*use\s*\}\s*from\s*['"]react['"]/.test(appR),
  );

  // ===== 7) BFF import 但 config 无 plugins 数组：必须真的插入 bffPlugin() =====
  console.log('== v2-edge-bff-noplugins (defineConfig({}) + bff import) ==');
  const bn = prepare('v2-edge-bff-noplugins');
  const cfgBn = bn.read('modern.config.ts');
  check(
    '无 plugins 数组时仍插入 plugins: [bffPlugin()]',
    /plugins\s*:\s*\[[^\]]*bffPlugin\(\)/.test(cfgBn),
  );
  check(
    '补 @modern-js/plugin-bff 依赖',
    JSON.parse(bn.read('package.json')).dependencies[
      '@modern-js/plugin-bff'
    ] === '3.0.0',
  );

  // ===== 8) RuntimeContext 返回值结构变化：context.isBrowser 进人工清单 =====
  console.log('== v2-edge-runtimectx (context.isBrowser) ==');
  const rc = prepare('v2-edge-runtimectx');
  check(
    'context.isBrowser 旧用法进人工清单',
    /isBrowser/.test(rc.report().manual.join('\n')),
  );

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
  console.log('✅ migrate-to-v3 skill 迁移验证通过');
} finally {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}
