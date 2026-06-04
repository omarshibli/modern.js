#!/usr/bin/env node
// 扫描一个 Modern.js 项目：判定是否 v3、列出可启用功能及其当前状态。
//   node scripts/scan.mjs <projectDir>
// 产出 <projectDir>/.agents/runs/modernjs-feature-enable/context.json

import fs from 'node:fs';
import path from 'node:path';
import {
  exists,
  findConfigFile,
  importSpecifiers,
  maskCommentsAndStrings,
  readText,
} from './lib.mjs';

function fail(msg) {
  console.error(`scan failed: ${msg}`);
  process.exit(1);
}

function main() {
  const dir = path.resolve(process.argv[2] || '.');
  if (!exists(dir, 'package.json')) fail(`缺少 package.json: ${dir}`);
  const pkg = JSON.parse(readText(path.join(dir, 'package.json')));
  const deps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };
  const appTools = deps['@modern-js/app-tools'] ?? null;
  if (!appTools) {
    fail(
      '未检测到 @modern-js/app-tools：feature-enable 仅用于 Modern.js（app-tools）应用',
    );
  }
  const major = Number(String(appTools).match(/(\d+)/)?.[1]);
  // 注：v3 已移除 `modern new`，本 skill 即手动等价物（见 guides/upgrade/other.md）
  if (major === 2) {
    fail(
      '检测到 Modern.js v2：请先用 modernjs-migrate-to-v3 升级到 v3 再启用功能',
    );
  }

  const configFile = findConfigFile(dir);
  const configText = configFile ? readText(path.join(dir, configFile)) : '';
  const maskedCfg = maskCommentsAndStrings(configText);
  const specs = configText ? importSpecifiers(configText) : [];

  const features = {
    bff: {
      label: 'BFF（一体化后端）',
      automated: true,
      enabled:
        /\bbffPlugin\s*\(/.test(maskedCfg) &&
        specs.includes('@modern-js/plugin-bff'),
      doc: 'references/enable-bff.md',
    },
    server: {
      label: '自定义 Web Server',
      automated: false,
      enabled: exists(dir, 'server', 'modern.server.ts'),
      doc: 'references/other-features.md',
    },
    tailwindcss: {
      label: 'Tailwind CSS',
      automated: false,
      enabled: Boolean(deps['@modern-js/plugin-tailwindcss']),
      doc: 'references/other-features.md',
    },
    ssg: {
      label: '静态站点生成 SSG',
      automated: false,
      enabled: /\bssg\b/.test(maskedCfg),
      doc: 'references/other-features.md',
    },
    microFrontend: {
      label: '微前端（Garfish）',
      automated: false,
      enabled: Boolean(deps['@modern-js/plugin-garfish']),
      doc: 'references/other-features.md',
    },
  };

  const context = {
    projectDir: dir,
    modernVersion: appTools,
    migrationState: 'v3',
    configFile,
    features,
  };
  const outDir = path.join(dir, '.agents', 'runs', 'modernjs-feature-enable');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'context.json'),
    `${JSON.stringify(context, null, 2)}\n`,
  );

  console.log(`projectDir: ${dir}`);
  console.log(`modern: ${appTools} (v3)`);
  console.log('可启用功能：');
  for (const [k, v] of Object.entries(features)) {
    const status = v.enabled ? '已启用' : '未启用';
    const auto = v.automated ? '自动' : 'manual';
    console.log(`  - ${k}（${v.label}）：${status} [${auto}]`);
  }
}

main();
