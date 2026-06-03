#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE_DIR = path.join(REPO_ROOT, 'skills/maintainer');

const TARGETS = {
  claude: '.claude/skills',
  codex: '.agents/skills',
  cursor: '.cursor/skills',
};

function usage() {
  console.log(`Sync Modern.js maintainer skills into agent tool directories.

Usage:
  node scripts/sync-maintainer-skills.mjs [--target=claude|codex|cursor|all] [--dry-run]

Defaults to --target=all.`);
}

function parseArgs(argv) {
  const args = {
    target: 'all',
    dryRun: false,
  };

  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg.startsWith('--target=')) {
      args.target = arg.slice('--target='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function resolveTargets(target) {
  const names =
    target === 'all'
      ? Object.keys(TARGETS)
      : target
          .split(',')
          .map(name => name.trim())
          .filter(Boolean);
  const unknown = names.filter(name => !TARGETS[name]);

  if (unknown.length > 0) {
    throw new Error(
      `Unknown target: ${unknown.join(', ')}. Expected claude, codex, cursor, or all.`,
    );
  }
  if (names.length === 0) {
    throw new Error('No target selected.');
  }

  return names;
}

function listSkillDirs() {
  if (!fs.existsSync(SOURCE_DIR)) {
    return [];
  }

  return fs
    .readdirSync(SOURCE_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .filter(entry =>
      fs.existsSync(path.join(SOURCE_DIR, entry.name, 'SKILL.md')),
    )
    .map(entry => ({
      name: entry.name,
      source: path.join(SOURCE_DIR, entry.name),
    }));
}

function relativeSymlinkTarget(fromDir, toDir) {
  const relative = path.relative(fromDir, toDir);
  return relative.startsWith('.') ? relative : `.${path.sep}${relative}`;
}

function syncSkill(skill, targetName, dryRun) {
  const targetRoot = path.join(REPO_ROOT, TARGETS[targetName]);
  const dest = path.join(targetRoot, skill.name);
  const linkTarget = relativeSymlinkTarget(targetRoot, skill.source);

  if (dryRun) {
    console.log(
      `[dry-run] ${targetName}: ${path.relative(REPO_ROOT, dest)} -> ${linkTarget}`,
    );
    return;
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.symlinkSync(linkTarget, dest, 'dir');
  console.log(
    `${targetName}: ${path.relative(REPO_ROOT, dest)} -> ${linkTarget}`,
  );
}

function main() {
  const { target, dryRun } = parseArgs(process.argv);
  const targetNames = resolveTargets(target);
  const skills = listSkillDirs();

  if (skills.length === 0) {
    console.log('No maintainer skills found under skills/maintainer.');
    return;
  }

  for (const targetName of targetNames) {
    for (const skill of skills) {
      syncSkill(skill, targetName, dryRun);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
