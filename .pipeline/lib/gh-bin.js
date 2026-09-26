// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

// =============================================================================
// gh-bin.js — Resolución única del binario `gh` (#7438).
//
// Causa raíz de #7113: el Pulpo lanzado por `watchdog.ps1` / `launch.ps1` no
// tiene `gh` en el PATH, y dos módulos del gate (`design-decision-gate-io.js`
// y `gate1-signature-handler.js`) invocaban el literal pelado. Un issue con las
// cinco firmas de definición escalaba a `needs-human` por `spawnSync gh ENOENT`.
//
// Orden EXACTO de precedencia (el mismo que ya usaba `pipeline-states.js`):
//   argumento `ghBin` → env `GH_BIN` → env `GH_PATH` → `GH_BIN_DEFAULT`
// Semántica `||`: `''`/`undefined` en un nivel cae al siguiente.
//
// RS-1.1 (security): la fuente permitida es SOLO el argumento explícito, el env
// del proceso y un default hardcodeado fuera del repo. Nunca `fs`, nunca la
// configuración YAML del pipeline, nunca un body de issue. Hay test
// estructural que lo asegura.
// =============================================================================
'use strict';

const GH_BIN_DEFAULT = process.platform === 'win32' ? 'C:/Workspaces/gh-cli/bin/gh' : 'gh';

/**
 * Devuelve el path/nombre del binario `gh` a invocar.
 *
 * @param {object} [opts]
 * @param {string} [opts.ghBin] — override explícito (inyección en tests / runners).
 * @returns {string}
 */
function resolveGhBin({ ghBin } = {}) {
    return ghBin || process.env.GH_BIN || process.env.GH_PATH || GH_BIN_DEFAULT;
}

module.exports = { GH_BIN_DEFAULT, resolveGhBin };
