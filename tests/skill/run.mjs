#!/usr/bin/env node
// 验证 modernjs-migrate-to-v3 skill：把 fixtures/v2-app 复制到临时目录，跑
// scan-project.mjs + migrate.mjs，断言迁移结果符合 v2→v3 文档。
//   node tests/skill/run.mjs
// 退出码非 0 表示有断言失败。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const FIXTURE = path.join(HERE, 'fixtures', 'v2-app');
const SCRIPTS = path.join(
  REPO,
  'packages/toolkit/skills/catalog/modernjs-migrate-to-v3/scripts',
);

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
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-migrate-'));
try {
  copyDir(FIXTURE, work);

  // 1) scan
  const scanOut = execFileSync(
    'node',
    [path.join(SCRIPTS, 'scan-project.mjs'), work],
    { encoding: 'utf8' },
  );
  console.log('[scan]');
  check('扫描判定为 v2 项目', /\(v2\)/.test(scanOut));
  check(
    '扫描命中 import-bff / app-config / tailwind 等特征',
    /features:.*(app-config|import-bff|tailwind)/.test(scanOut),
  );
  const ctx = JSON.parse(
    fs.readFileSync(
      path.join(work, '.agents/runs/modernjs-migrate/context.json'),
      'utf8',
    ),
  );
  check('context.json migrationState=v2', ctx.migrationState === 'v2');

  // 2) migrate
  execFileSync(
    'node',
    [path.join(SCRIPTS, 'migrate.mjs'), work, '--to=3.0.0'],
    {
      encoding: 'utf8',
    },
  );
  const read = rel => fs.readFileSync(path.join(work, rel), 'utf8');
  const has = rel => fs.existsSync(path.join(work, rel));

  console.log('[deps]');
  const pkg = JSON.parse(read('package.json'));
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
  check('生成 postcss.config.cjs', has('postcss.config.cjs'));

  console.log('[config]');
  const cfg = read('modern.config.ts');
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

  console.log('[entry / runtime config]');
  const app = read('src/App.tsx');
  check('App.tsx 不再有 App.config', !/\bApp\.config\b/.test(app));
  check('生成 src/modern.runtime.ts', has('src/modern.runtime.ts'));
  const rt = has('src/modern.runtime.ts') ? read('src/modern.runtime.ts') : '';
  check(
    'modern.runtime.ts 含 defineRuntimeConfig + supportHtml5History',
    /defineRuntimeConfig/.test(rt) && /supportHtml5History/.test(rt),
  );

  console.log('[import paths]');
  check(
    'App.tsx: runtime/bff → plugin-bff/runtime',
    !app.includes('@modern-js/runtime/bff') &&
      app.includes('@modern-js/plugin-bff/runtime'),
  );
  const server = read('server/index.ts');
  check(
    'server: runtime/server → server-runtime',
    !server.includes('@modern-js/runtime/server') &&
      server.includes('@modern-js/server-runtime'),
  );

  console.log('[runtime context]');
  check(
    'useRuntimeContext → use(RuntimeContext)',
    !/\buseRuntimeContext\b/.test(app) &&
      app.includes('use(RuntimeContext)') &&
      /from\s+['"]react['"]/.test(app),
  );

  console.log('[manual checklist]');
  const report = JSON.parse(read('.agents/runs/modernjs-migrate/report.json'));
  const manualText = report.manual.join('\n');
  check('人工清单含 App.init', /App\.init/.test(manualText));
  check(
    '人工清单含 自定义 server',
    /server/.test(manualText) && /modern\.server/.test(manualText),
  );
  check('人工清单含 appIcon', /appIcon/.test(manualText));
  check('人工清单含 ssr', /ssr|SSR/.test(manualText));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
  console.log('✅ migrate-to-v3 skill 迁移验证通过');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
