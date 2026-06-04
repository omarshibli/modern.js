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

  // ===== SSG：未启用 → 启用（clean v3 app）=====
  console.log('== feature-enable ssg (v3-app-no-bff) ==');
  const s = prepare('v3-app-no-bff');
  const sScan = execFileSync('node', [path.join(SCRIPTS, 'scan.mjs'), s.work], {
    encoding: 'utf8',
  });
  check('scan: ssg 标为 [自动]', /ssg（.*）：未启用 \[自动\]/.test(sScan));
  execFileSync('node', [path.join(SCRIPTS, 'enable.mjs'), 'ssg', s.work], {
    encoding: 'utf8',
  });
  const sPkg = JSON.parse(s.read('package.json'));
  check(
    '[auto] 新增 @modern-js/plugin-ssg，版本与 app-tools 一致',
    sPkg.dependencies['@modern-js/plugin-ssg'] ===
      sPkg.devDependencies['@modern-js/app-tools'],
  );
  const sCfg = s.read('modern.config.ts');
  check(
    '[auto] plugins 追加 ssgPlugin()',
    /plugins\s*:\s*\[\s*appTools\(\)\s*,\s*ssgPlugin\(\)\s*\]/.test(sCfg),
  );
  check(
    '[auto] output 合并 ssg: true',
    /output\s*:\s*\{[^}]*ssg:\s*true/.test(sCfg),
  );
  check(
    '[auto] import ssgPlugin 只 1 处',
    (sCfg.match(/@modern-js\/plugin-ssg/g) || []).length === 1,
  );

  // SSG：已有 output 块 → 合并 ssg、保留其它 key
  console.log('== feature-enable ssg (existing output → merge) ==');
  const so = prepare('v3-app-ssg-output');
  execFileSync('node', [path.join(SCRIPTS, 'enable.mjs'), 'ssg', so.work], {
    encoding: 'utf8',
  });
  const soCfg = so.read('modern.config.ts');
  check(
    '[auto] 既有 output.polyfill 保留 + 合并 ssg: true',
    /ssg:\s*true/.test(soCfg) && /polyfill:\s*'usage'/.test(soCfg),
  );

  // ===== CJS：module.exports/require 配置插 require 绑定（梅长苏 blocker）=====
  console.log('== feature-enable bff (CJS module.exports config) ==');
  const cjs = prepare('v3-app-cjs-config');
  execFileSync('node', [path.join(SCRIPTS, 'enable.mjs'), 'bff', cjs.work], {
    encoding: 'utf8',
  });
  const cjsCfg = cjs.read('modern.config.js');
  check(
    '[auto] CJS 配置插入 require 绑定（非 ESM import）',
    /const\s*\{\s*bffPlugin\s*\}\s*=\s*require\(\s*['"]@modern-js\/plugin-bff['"]\s*\)/.test(
      cjsCfg,
    ),
  );
  check(
    '[auto] CJS plugins 追加 bffPlugin()',
    /plugins\s*:\s*\[[^\]]*bffPlugin\(\)/.test(cjsCfg),
  );
  check(
    '[auto] CJS 未引入 ESM import（保持 module.exports 风格）',
    !/^import\s/m.test(cjsCfg),
  );
  check(
    '[auto] CJS config report.manual 无「绑定缺失」类残留',
    !/undefined|未导入/.test(cjs.report().manual.join('\n')),
  );

  // ===== call 但缺绑定（半启用坏态）→ 补齐绑定、不重复加调用 =====
  console.log('== feature-enable bff (call without binding → repair) ==');
  const nb = prepare('v3-app-bff-no-binding');
  execFileSync('node', [path.join(SCRIPTS, 'enable.mjs'), 'bff', nb.work], {
    encoding: 'utf8',
  });
  const nbCfg = nb.read('modern.config.ts');
  check(
    '[repair] 补齐缺失的 bffPlugin import 绑定',
    /import\s*\{\s*bffPlugin\s*\}\s*from\s*['"]@modern-js\/plugin-bff['"]/.test(
      nbCfg,
    ),
  );
  check(
    '[repair] bffPlugin() 调用不重复（仍只 1 处）',
    (nbCfg.match(/bffPlugin\(\)/g) || []).length === 1,
  );

  // ===== 绑定解析 blocker（刺儿头 + 梅长苏）=====
  // B1：普通字符串里的伪 import 不算绑定 → 必须插入真实 import，字符串原样
  console.log('== binding: string fake import ≠ real binding ==');
  const sf = prepare('v3-app-string-fake-import');
  execFileSync('node', [path.join(SCRIPTS, 'enable.mjs'), 'bff', sf.work], {
    encoding: 'utf8',
  });
  const sfCfg = sf.read('modern.config.ts');
  check(
    '插入真实 import { bffPlugin } from ...（非依赖字符串伪 import）',
    /^import\s*\{\s*bffPlugin\s*\}\s*from\s*['"]@modern-js\/plugin-bff['"]/m.test(
      sfCfg,
    ),
  );
  check('普通字符串伪 import 原样保留', sfCfg.includes('const doc ='));

  // B2：specifier 在但缺 export + 有调用 → 把 export 加进现有大括号，调用不重复
  console.log(
    '== binding: specifier present, export missing → add to braces ==',
  );
  const sm = prepare('v3-app-bff-specifier-missing');
  execFileSync('node', [path.join(SCRIPTS, 'enable.mjs'), 'bff', sm.work], {
    encoding: 'utf8',
  });
  const smCfg = sm.read('modern.config.ts');
  check(
    'bffPlugin 加进现有 import 大括号（{ other, bffPlugin }）',
    /import\s*\{[^}]*\bother\b[^}]*\bbffPlugin\b[^}]*\}\s*from\s*['"]@modern-js\/plugin-bff['"]/.test(
      smCfg,
    ),
  );
  check(
    'bffPlugin() 调用不重复（仍 1 处）',
    (smCfg.match(/bffPlugin\(\)/g) || []).length === 1,
  );

  // B3：ESM alias 已启用 → 幂等（不重复 append alias 调用）
  console.log('== idempotent: ESM alias already enabled ==');
  const al = prepare('v3-app-bff-alias');
  const alOut = execFileSync(
    'node',
    [path.join(SCRIPTS, 'enable.mjs'), 'bff', al.work, '--json'],
    { encoding: 'utf8' },
  );
  check('alias 已启用：changed 为空', JSON.parse(alOut).changed.length === 0);
  check(
    'alias 调用不重复（bff() 仍 1 处）',
    (al.read('modern.config.ts').match(/\bbff\(\)/g) || []).length === 1,
  );

  // B4：SSG 半启用（有 plugin、缺 output.ssg）→ 补齐 output.ssg
  console.log(
    '== ssg: half-enabled (plugin, no output.ssg) → add output.ssg ==',
  );
  const sh = prepare('v3-app-ssg-half');
  const shScan = execFileSync(
    'node',
    [path.join(SCRIPTS, 'scan.mjs'), sh.work],
    {
      encoding: 'utf8',
    },
  );
  check('scan: 半启用 SSG 不被标为已启用', /ssg（.*）：未启用/.test(shScan));
  execFileSync('node', [path.join(SCRIPTS, 'enable.mjs'), 'ssg', sh.work], {
    encoding: 'utf8',
  });
  const shCfg = sh.read('modern.config.ts');
  check('补齐 output.ssg: true', /output\s*:\s*\{[^}]*ssg:\s*true/.test(shCfg));
  check(
    'ssgPlugin() 调用不重复（仍 1 处）',
    (shCfg.match(/ssgPlugin\(\)/g) || []).length === 1,
  );

  // B5：type-only import 不算 value 绑定 → 另插一条 value import，type import 原样
  console.log('== binding: import type ≠ value binding ==');
  const ti = prepare('v3-app-bff-type-import');
  execFileSync('node', [path.join(SCRIPTS, 'enable.mjs'), 'bff', ti.work], {
    encoding: 'utf8',
  });
  const tiCfg = ti.read('modern.config.ts');
  check(
    'import type 原样保留（未被塞入 bffPlugin）',
    /import\s+type\s*\{\s*BffConfig\s*\}\s*from\s*['"]@modern-js\/plugin-bff['"]/.test(
      tiCfg,
    ),
  );
  check(
    '另插一条 value import { bffPlugin }',
    /^import\s*\{\s*bffPlugin\s*\}\s*from\s*['"]@modern-js\/plugin-bff['"]/m.test(
      tiCfg,
    ),
  );
  check(
    'plugins 追加 bffPlugin()',
    /plugins\s*:\s*\[[^\]]*bffPlugin\(\)/.test(tiCfg),
  );

  // B6：output.ssg: false 不算已启用 → scan 未启用 + enable 翻成 true
  console.log('== ssg: output.ssg false ≠ enabled → flip to true ==');
  const sff = prepare('v3-app-ssg-false');
  const sffScan = execFileSync(
    'node',
    [path.join(SCRIPTS, 'scan.mjs'), sff.work],
    { encoding: 'utf8' },
  );
  check(
    'scan: output.ssg:false 不被标为已启用',
    /ssg（.*）：未启用/.test(sffScan),
  );
  execFileSync('node', [path.join(SCRIPTS, 'enable.mjs'), 'ssg', sff.work], {
    encoding: 'utf8',
  });
  const sffCfg = sff.read('modern.config.ts');
  check(
    'output.ssg: false → true（按启用意图）',
    /\bssg\s*:\s*true\b/.test(sffCfg),
  );
  check('未残留 ssg: false', !/\bssg\s*:\s*false\b/.test(sffCfg));

  // B7：output.ssg 结构化改写——只翻顶层真实 ssg，不动字符串/注释/嵌套 experimental.ssg
  console.log(
    '== ssg: structural output.ssg (string/comment/nested untouched) ==',
  );
  const to = prepare('v3-app-ssg-tricky-output');
  execFileSync('node', [path.join(SCRIPTS, 'enable.mjs'), 'ssg', to.work], {
    encoding: 'utf8',
  });
  const toCfg = to.read('modern.config.ts');
  check('顶层 output.ssg false → true', /\bssg\s*:\s*true\b/.test(toCfg));
  check(
    '字符串 "ssg: false in a string" 原样保留',
    toCfg.includes('ssg: false in a string'),
  );
  check(
    '注释 // ssg: false 原样保留',
    toCfg.includes('// ssg: false in a comment'),
  );
  check(
    '嵌套 experimental: { ssg: false } 原样保留',
    /experimental\s*:\s*\{\s*ssg\s*:\s*false\s*\}/.test(toCfg),
  );
  check(
    'output.ssg true 仅 1 处（未误翻其它）',
    (toCfg.match(/\bssg\s*:\s*true\b/g) || []).length === 1,
  );

  // B8：output 值非对象字面量（动态表达式）→ 进 manual，不改坏表达式
  console.log('== ssg: output value is expression → manual (untouched) ==');
  const oe = prepare('v3-app-ssg-output-expr');
  execFileSync('node', [path.join(SCRIPTS, 'enable.mjs'), 'ssg', oe.work], {
    encoding: 'utf8',
  });
  const oeCfg = oe.read('modern.config.ts');
  check(
    '动态 output 表达式原样保留',
    oeCfg.includes('makeOutput({ ssg: false })'),
  );
  check(
    'output 非对象字面量进 manual',
    /output 值不是对象字面量/.test(oe.report().manual.join('\n')),
  );

  // B9：output.ssg 值为 undefined（非启用字面量）→ scan 未启用 + enable 翻 true
  console.log('== ssg: output.ssg undefined ≠ enabled → flip ==');
  const su = prepare('v3-app-ssg-undefined');
  const suScan = execFileSync(
    'node',
    [path.join(SCRIPTS, 'scan.mjs'), su.work],
    { encoding: 'utf8' },
  );
  check(
    'scan: output.ssg undefined 不被标已启用',
    /ssg（.*）：未启用/.test(suScan),
  );
  execFileSync('node', [path.join(SCRIPTS, 'enable.mjs'), 'ssg', su.work], {
    encoding: 'utf8',
  });
  const suCfg = su.read('modern.config.ts');
  check('output.ssg undefined → true', /\bssg\s*:\s*true\b/.test(suCfg));
  check('未残留 ssg: undefined', !/\bssg\s*:\s*undefined\b/.test(suCfg));

  // B10：output 值是数组字面量（非对象）→ 同样进 manual、不下钻改写
  console.log('== ssg: output value is array literal → manual (untouched) ==');
  const oa = prepare('v3-app-ssg-output-array');
  execFileSync('node', [path.join(SCRIPTS, 'enable.mjs'), 'ssg', oa.work], {
    encoding: 'utf8',
  });
  const oaCfg = oa.read('modern.config.ts');
  check(
    '数组 output 原样保留',
    /output:\s*\[\{\s*ssg:\s*false\s*\}\]/.test(oaCfg),
  );
  check(
    'output 数组进 manual（未误改成对象）',
    /output 值不是对象字面量/.test(oa.report().manual.join('\n')) &&
      !/\bssg\s*:\s*true\b/.test(oaCfg),
  );

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
  console.log('✅ feature-enable skill 验证通过');
} finally {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}
