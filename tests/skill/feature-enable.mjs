#!/usr/bin/env node
// 验证 modernjs-feature-enable skill：把 v3-app-no-bff fixture 复制到临时目录，跑
// scan.mjs + enable.mjs bff，断言从「未启用 BFF」迁到「可安装/可构建的 BFF 已启用」形态。
//   node tests/skill/feature-enable.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SCRIPTS = path.join(
  REPO,
  'packages/toolkit/skills/catalog/modernjs-feature-enable/scripts',
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

function prepare(fixture) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-feat-'));
  tmpDirs.push(work);
  copyDir(path.join(HERE, 'fixtures', fixture), work);
  return {
    work,
    read: rel => fs.readFileSync(path.join(work, rel), 'utf8'),
    has: rel => fs.existsSync(path.join(work, rel)),
    report: () =>
      JSON.parse(
        fs.readFileSync(
          path.join(work, '.agents/runs/modernjs-feature-enable/report.json'),
          'utf8',
        ),
      ),
  };
}

try {
  // ===== BFF：未启用 → 启用 =====
  console.log('== feature-enable bff (v3-app-no-bff) ==');
  const a = prepare('v3-app-no-bff');
  check(
    '[provenance] 含 PROVENANCE.md（裁剪自 create 模板）',
    a.has('PROVENANCE.md'),
  );

  const scanOut = execFileSync(
    'node',
    [path.join(SCRIPTS, 'scan.mjs'), a.work],
    {
      encoding: 'utf8',
    },
  );
  check('scan 判定 v3', /\(v3\)/.test(scanOut));
  check('scan: bff 未启用 [自动]', /bff（.*）：未启用 \[自动\]/.test(scanOut));

  execFileSync('node', [path.join(SCRIPTS, 'enable.mjs'), 'bff', a.work], {
    encoding: 'utf8',
  });

  const pkg = JSON.parse(a.read('package.json'));
  const appToolsVer = pkg.devDependencies['@modern-js/app-tools'];
  check(
    '[auto] 新增 @modern-js/plugin-bff，且版本与 app-tools 一致',
    pkg.dependencies['@modern-js/plugin-bff'] === appToolsVer,
  );

  const cfg = a.read('modern.config.ts');
  check(
    '[auto] config plugins 追加 bffPlugin()（顺序 appTools 在前）',
    /plugins\s*:\s*\[\s*appTools\(\)\s*,\s*bffPlugin\(\)\s*\]/.test(cfg),
  );
  check(
    '[auto] import bffPlugin 只 1 处（不重复声明）',
    (cfg.match(/@modern-js\/plugin-bff/g) || []).length === 1 &&
      /import\s*\{\s*bffPlugin\s*\}\s*from\s*['"]@modern-js\/plugin-bff['"]/.test(
        cfg,
      ),
  );

  const tsconfig = JSON.parse(a.read('tsconfig.json'));
  check(
    '[auto] tsconfig 加 @api/* 别名',
    JSON.stringify(tsconfig.compilerOptions.paths['@api/*']) ===
      JSON.stringify(['./api/lambda/*']),
  );
  check(
    '[auto] tsconfig include 加 api（保留原有 src 等）',
    tsconfig.include.includes('api') && tsconfig.include.includes('src'),
  );
  check(
    '[provenance] tsconfig 原有 @/* 别名保留',
    JSON.stringify(tsconfig.compilerOptions.paths['@/*']) ===
      JSON.stringify(['./src/*']),
  );

  check('[auto] scaffold api/lambda/index.ts', a.has('api/lambda/index.ts'));
  check(
    '[auto] scaffold 内容是 BFF 函数（default export async）',
    /export default async/.test(a.read('api/lambda/index.ts')),
  );

  const report = a.report();
  check('report.changed 含 4 项自动改写', report.changed.length === 4);
  check(
    'report.manual 为空（干净 v3 app 可全自动）',
    report.manual.length === 0,
  );

  // ===== 幂等：再次 enable 不重复改写 =====
  console.log('== feature-enable bff idempotent (re-run) ==');
  const re = execFileSync(
    'node',
    [path.join(SCRIPTS, 'enable.mjs'), 'bff', a.work, '--json'],
    { encoding: 'utf8' },
  );
  const reReport = JSON.parse(re);
  check('幂等：第二次 enable 无 changed', reReport.changed.length === 0);
  check(
    '幂等：提示已启用、未重复改写',
    /已启用/.test(reReport.manual.join('\n')),
  );
  const cfg2 = a.read('modern.config.ts');
  check(
    '幂等：bffPlugin() 不重复',
    (cfg2.match(/bffPlugin\(\)/g) || []).length === 1,
  );

  // report 含 deprecated（stale-doc）分层
  check(
    '[stale-doc] report.deprecated 标注 modern new/upgrade 已移除',
    Boolean(
      report.deprecated?.removedCommands?.includes('modern new') &&
        /other\.md/.test(report.deprecated?.evidence ?? ''),
    ),
  );

  // ===== 负向 1：v2 项目（semver 2.x）→ enable 中止、零改动 =====
  console.log('== guard: v2 app (semver 2.x) must abort ==');
  const v2 = prepare('v2-app-needs-migrate');
  let v2Blocked = false;
  try {
    execFileSync('node', [path.join(SCRIPTS, 'enable.mjs'), 'bff', v2.work], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch {
    v2Blocked = true;
  }
  check('[guard] v2 项目 enable 非 0 中止', v2Blocked);
  check('[guard] v2 项目未生成 api/（零改动）', !v2.has('api/lambda/index.ts'));
  check(
    '[guard] v2 项目未写 plugin-bff 依赖',
    !JSON.parse(v2.read('package.json')).dependencies['@modern-js/plugin-bff'],
  );
  check(
    '[guard] v2 项目无 report（未执行）',
    !v2.has('.agents/runs/modernjs-feature-enable/report.json'),
  );

  // ===== 负向 2：workspace:* + v2-only 信号 → 按 v2 中止 =====
  console.log('== guard: workspace + v2 signal must abort ==');
  const wv2 = prepare('v2-workspace-signal');
  let wv2Blocked = false;
  try {
    execFileSync('node', [path.join(SCRIPTS, 'enable.mjs'), 'bff', wv2.work], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch {
    wv2Blocked = true;
  }
  check('[guard] workspace+v2信号 enable 中止（不误判 v3）', wv2Blocked);

  // ===== 负向 3：link: 协议 → enable 放行，但 plugin-bff 进 manual（不照搬错路径）=====
  console.log('== link: protocol → mapped dep manual ==');
  const lk = prepare('v3-app-bff-link');
  execFileSync('node', [path.join(SCRIPTS, 'enable.mjs'), 'bff', lk.work], {
    encoding: 'utf8',
  });
  const lkPkg = JSON.parse(lk.read('package.json'));
  check(
    '[guard] link: 协议未把 app-tools 路径写给 plugin-bff',
    !lkPkg.dependencies['@modern-js/plugin-bff'],
  );
  check(
    '[guard] link: 协议补依赖进 manual',
    /link:.*手动添加.*plugin-bff/s.test(lk.report().manual.join('\n')),
  );
  check(
    '[guard] link: 既有依赖仍可被改 config（plugins 加 bffPlugin）',
    /bffPlugin\(\)/.test(lk.read('modern.config.ts')),
  );

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
  console.log('✅ feature-enable skill 验证通过');
} finally {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}
