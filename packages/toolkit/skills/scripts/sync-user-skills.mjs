#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const SOURCE_DIR = path.join(REPO_ROOT, 'skills/user');
const DEST_DIR = path.join(PACKAGE_ROOT, 'catalog');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sourcePath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(sourcePath, destPath);
      continue;
    }

    if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destPath);
    }
  }
}

function listUserSkills() {
  if (!fs.existsSync(SOURCE_DIR)) {
    throw new Error(`Missing user skills source: ${SOURCE_DIR}`);
  }

  return fs
    .readdirSync(SOURCE_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .filter(entry =>
      fs.existsSync(path.join(SOURCE_DIR, entry.name, 'SKILL.md')),
    );
}

function main() {
  const skills = listUserSkills();

  fs.rmSync(DEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DEST_DIR, { recursive: true });

  for (const skill of skills) {
    copyDir(path.join(SOURCE_DIR, skill.name), path.join(DEST_DIR, skill.name));
    console.log(`synced ${skill.name}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
