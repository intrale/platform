#!/usr/bin/env node
// qa-validate-video.js — Valida un video de evidencia QA.
//
// Uso:
//   node qa/scripts/qa-validate-video.js <path-al-video.mp4>
//
// Salida JSON:
//   { "valid": bool, "size_bytes": n, "warnings": [...], "errors": [...] }
// Exit codes:
//   0: válido (puede tener warnings)
//   1: archivo no existe o demasiado chico (<200KB)
//   2: argumentos inválidos

'use strict';

const fs = require('fs');

const MIN_VALID_SIZE = 200 * 1024; // 200KB
const TINY_SIZE = 50 * 1024; // 50KB

function emit(obj, exitCode) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(exitCode);
}

const videoPath = process.argv[2];
if (!videoPath) {
  emit({ valid: false, errors: ['missing argument: video path'] }, 2);
}

let stat;
try {
  stat = fs.statSync(videoPath);
} catch (err) {
  emit({ valid: false, size_bytes: 0, errors: [`file not found: ${videoPath}`] }, 1);
}

const size = stat.size;
const warnings = [];
const errors = [];

if (size < TINY_SIZE) {
  errors.push(`video too small (${size} bytes < ${TINY_SIZE}) — recording likely failed`);
} else if (size < MIN_VALID_SIZE) {
  warnings.push(`video small (${size} bytes < ${MIN_VALID_SIZE}) — may indicate truncated recording`);
}

const valid = errors.length === 0;
emit(
  {
    valid,
    size_bytes: size,
    warnings,
    errors,
  },
  valid ? 0 : 1,
);
