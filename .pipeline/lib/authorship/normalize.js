// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
// =============================================================================
// #7631 — Normalización de líneas antes de cualquier regex de autoría (SEC-C).
//
// Módulo PURO y sin I/O: lo importan `trailer.js`, el strip del ancla del body
// del PR y (en la hija de CI) el verificador que corre desde `main`.
//
// La normalización sirve SÓLO para DECIDIR qué se elimina. El texto que
// sobrevive se emite en su forma original, nunca normalizado.
// =============================================================================

// Ancho cero, marcas de dirección y controles bidi que permiten esconder una
// clave de trailer a un regex ingenuo (`Intrale​-Issue:`).
//   U+200B–U+200F · U+202A–U+202E · U+2060–U+2069 · U+FEFF
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/g;

// Separadores homoglifos de `:`. NFKC ya convierte el fullwidth (U+FF1A) en
// `:`, pero el modificador U+A789 (`꞉`) sobrevive a NFKC: el mapeo explícito
// cubre los dos por las dudas.
const COLON_LIKE = /[：꞉]/g;

function normalizeLine(s) {
    return String(s == null ? '' : s)
        .normalize('NFKC')
        .replace(INVISIBLE, '')
        .replace(COLON_LIKE, ':');
}

module.exports = { normalizeLine, INVISIBLE, COLON_LIKE };
