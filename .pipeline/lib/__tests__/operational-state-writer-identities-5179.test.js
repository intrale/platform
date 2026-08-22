// =============================================================================
// #5179 CA-7b — Test de identidades de los escritores migrados al envoltorio.
//
// Recorre los call sites ESCRITORES migrados al envoltorio único de estado
// operativo y falla si algún `authorizedBy` cae fuera de
// `AUTHORIZED_BY_ENUM ∪ RECURSIVE_DEPS_RE`. El mensaje NOMBRA el call site
// infractor (archivo:línea + mutador), porque un fallo que no dice dónde está el
// problema obliga a reconstruirlo a mano.
//
// ALCANCE — no mezclar enums (R4 / D2)
// ------------------------------------
// Se valida SÓLO contra el enum de `partial-pause-audit.js`. Deliberadamente NO
// se recorre `lib/kernel-actions-audit.js`, que tiene su PROPIO enum: el
// `authorizedBy: 'kernel:auto'` de `scripts/init-waves-from-partial.js` es válido
// ahí y NO es un desvío. Incluirlo volvería el criterio autocontradictorio.
// Por la misma razón queda afuera `waves.rollbackIssueAdd` (`wave-add-rollback`),
// que es del enum de `lib/waves.js`.
//
// Tampoco se valida contra `KNOWN_SOURCES`: ése registra QUIÉN ORIGINÓ la
// mutación y no autoriza removals. Mezclarlo ensancharía el gate de autorización
// (es lo que advierte el comentario del propio enum).
//
// CÓMO SE DELIMITA "MIGRADO"
// --------------------------
// Se matchean los nombres de mutador propios del ENVOLTORIO (`setAllowlist`,
// `clearAllowlist`, …). Eso excluye solo los call sites legacy que siguen
// llamando `setPartialPause`/`clearPartialPause` directo (superficie ancha →
// #5164) aunque vivan en el mismo archivo — p. ej. los endpoints de allowlist de
// `dashboard.js`, que no entran a este issue.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const audit = require('../partial-pause-audit.js');

const PIPELINE = path.resolve(__dirname, '..', '..');

// Archivos con escritores migrados en #5179 (grupo 3 + escrituras del grupo 3b).
const ESCRITORES_MIGRADOS = [
    'lib/wave-dispatch.js',
    'lib/waves-api.js',
    'lib/allowlist-recursive-promote.js',
    'lib/commander-deterministic.js',
    'lib/commander/product-executor.js',
    'lib/dashboard-routes.js',
    'lib/wizards/allowlist/index.js',
    'lib/wizards/pausa/index.js',
    'dashboard.js',
    'restart.js',
];

// Superficie mutadora del envoltorio (`lib/operational-state.js`).
const MUTADORES = [
    'setAllowlist', 'setAllowlistAtomic', 'addToAllowlist', 'removeFromAllowlist',
    'clearAllowlist', 'resumeAll', 'setFullPause', 'clearFullPause',
];

// D2 — desvíos CONOCIDOS y CERRADOS, con su valor esperado. Los dos viven en
// `product-executor.js` y quedan fuera del enum a propósito: decidir el modelo de
// identidad de producto es trabajo de #5165. Ensanchar el enum ahora es el
// hallazgo [Alta][A01] de `security` (el enum autoriza removals de allowlist y
// el `productId` sale de config.yaml, editable por el operador).
const DESVIOS_5165 = [
    { file: 'lib/commander/product-executor.js', value: 'product-commander:${productId}' },
    { file: 'lib/commander/product-executor.js', value: 'resume:product-commander:${productId}' },
];

// ─── Extracción estática ────────────────────────────────────────────────────

/** Contenido balanceado que abre en `openIdx` (soporta `(` y `{`). */
function extractBalanced(src, openIdx) {
    const open = src[openIdx];
    const close = open === '(' ? ')' : '}';
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        const ch = src[i];
        if (ch === open) depth++;
        else if (ch === close) {
            depth--;
            if (depth === 0) return src.slice(openIdx + 1, i);
        }
    }
    return '';
}

/** Texto de los argumentos de la llamada que abre en `openIdx` (índice del `(`). */
function extractCallArgs(src, openIdx) {
    return extractBalanced(src, openIdx);
}

/** Expresión cruda asociada a `authorizedBy` dentro de un texto dado. */
function findAuthorizedByInline(argsText) {
    // Forma `authorizedBy: <expr>` — se corta en la coma de nivel 0.
    const m = /\bauthorizedBy\s*:\s*/.exec(argsText);
    if (m) {
        const start = m.index + m[0].length;
        let depth = 0;
        let enTemplate = false;   // el backtick ABRE y CIERRA con el mismo carácter
        for (let i = start; i < argsText.length; i++) {
            const ch = argsText[i];
            if (ch === '`') { enTemplate = !enTemplate; continue; }
            if (enTemplate) continue;
            if ('([{'.includes(ch)) depth++;
            else if (')]}'.includes(ch)) { if (depth === 0) return argsText.slice(start, i).trim(); depth--; }
            else if (ch === ',' && depth === 0) return argsText.slice(start, i).trim();
        }
        return argsText.slice(start).trim();
    }
    // Forma shorthand `authorizedBy,` / `authorizedBy }`.
    if (/\bauthorizedBy\s*(?:,|\})/.test(argsText)) return 'authorizedBy';
    return null;
}

/**
 * Expresión de `authorizedBy` para una llamada. Cubre las dos formas vivas:
 *   1. objeto de opts INLINE en la llamada (la mayoría).
 *   2. objeto de opts pasado POR VARIABLE — `setFullPause(gateOpts)` de los
 *      wizards, donde `const gateOpts = { authorizedBy: AUTHORIZED_BY, … }` se
 *      declara antes. Sin esto el recorrido perdía los 5 call sites del wizard
 *      de pausa: el test habría quedado verde por no mirarlos (lo detectó el
 *      chequeo anti-vacuidad).
 */
function findAuthorizedByExpr(argsText, src) {
    const inline = findAuthorizedByInline(argsText);
    if (inline !== null) return inline;

    for (const id of new Set(argsText.match(/\b[A-Za-z_$][\w$]*\b/g) || [])) {
        const decl = new RegExp(`(?:const|let|var)\\s+${id}\\s*=\\s*\\{`).exec(src);
        if (!decl) continue;
        const braceIdx = src.indexOf('{', decl.index);
        const objText = extractBalanced(src, braceIdx);
        const found = findAuthorizedByInline(objText);
        if (found !== null) return found;
    }
    return null;
}

/**
 * Resuelve una expresión a su valor textual. Los `${...}` se conservan tal cual
 * (`product-commander:${productId}`) para que un desvío dinámico sea comparable
 * de forma estable. Resuelve una indirección por constante del mismo archivo.
 */
function resolveExpr(expr, src, depthGuard = 0) {
    if (!expr || depthGuard > 4) return null;
    const e = expr.trim();

    // Literal de string simple.
    const lit = /^'([^']*)'$|^"([^"]*)"$/.exec(e);
    if (lit) return lit[1] !== undefined ? lit[1] : lit[2];

    // Template literal: se resuelven las interpolaciones que sean identificadores
    // definidos en el archivo; el resto queda como `${expr}`.
    if (/^`[^`]*`$/.test(e)) {
        const body = e.slice(1, -1);
        return body.replace(/\$\{([^}]+)\}/g, (full, inner) => {
            const resolved = resolveExpr(inner.trim(), src, depthGuard + 1);
            return resolved === null ? full : resolved;
        });
    }

    // Identificador → `const/let X = <expr>` en el mismo archivo. Se acepta el
    // patrón `opts.x || <expr>` quedándose con el fallback estático.
    if (/^[A-Za-z_$][\w$]*$/.test(e)) {
        const re = new RegExp(`(?:const|let|var)\\s+${e}\\s*=\\s*([^;\\n]+)`);
        const decl = re.exec(src);
        if (decl) {
            let rhs = decl[1].trim();
            const orMatch = /\|\|\s*(.+)$/.exec(rhs);
            if (orMatch) rhs = orMatch[1].trim();
            return resolveExpr(rhs, src, depthGuard + 1);
        }
    }
    return null;
}

function lineOf(src, idx) {
    return src.slice(0, idx).split('\n').length;
}

/** Todos los call sites de mutadores del envoltorio en los archivos migrados. */
function collectCallSites() {
    const out = [];
    const mutadoresRe = new RegExp(`\\b(${MUTADORES.join('|')})\\s*\\(`, 'g');
    for (const rel of ESCRITORES_MIGRADOS) {
        const abs = path.join(PIPELINE, rel);
        const src = fs.readFileSync(abs, 'utf8');
        mutadoresRe.lastIndex = 0;
        let m;
        while ((m = mutadoresRe.exec(src)) !== null) {
            const openIdx = m.index + m[0].length - 1;
            const argsText = extractCallArgs(src, openIdx);
            // Sin `authorizedBy` en los argumentos no es un call site de mutación
            // real (p. ej. el `typeof pp.setFullPause !== 'function'` del guard, o
            // la definición de la propia fachada).
            const expr = findAuthorizedByExpr(argsText, src);
            if (expr === null) continue;
            out.push({
                file: rel,
                line: lineOf(src, m.index),
                mutador: m[1],
                expr,
                value: resolveExpr(expr, src),
            });
        }
    }
    return out;
}

function esValorDeEnum(value) {
    if (value === null) return false;
    if (audit.AUTHORIZED_BY_STATIC.includes(value)) return true;
    // Forma dinámica `recursive-deps:from-N`: se acepta el N concreto o la
    // interpolación sin resolver.
    if (audit.RECURSIVE_DEPS_RE.test(value)) return true;
    if (/^recursive-deps:from-\$\{[^}]+\}$/.test(value)) return true;
    return false;
}

const CALL_SITES = collectCallSites();

// ─── Tests ──────────────────────────────────────────────────────────────────

test('el recorrido encuentra call sites en TODOS los archivos migrados (anti-vacuidad)', () => {
    // Sin esto, cualquier rotura del extractor dejaría el test verde por vacío:
    // un análisis estático que no encuentra nada "no falla", y el gate se apaga
    // en silencio. El conteo mínimo se ancla por archivo, no en total.
    assert.ok(CALL_SITES.length > 0, 'no se encontró NINGÚN call site: el extractor está roto');
    const porArchivo = new Set(CALL_SITES.map(c => c.file));
    for (const rel of ESCRITORES_MIGRADOS) {
        assert.ok(
            porArchivo.has(rel),
            `no se encontró ningún call site de mutación en ${rel}. O se revirtió la ` +
            'migración de ese archivo, o el extractor dejó de reconocer la forma de llamada.',
        );
    }
});

test('todo authorizedBy de un escritor migrado resuelve a un valor conocido', () => {
    const irresolubles = CALL_SITES.filter(c => c.value === null);
    assert.deepEqual(
        irresolubles.map(c => `${c.file}:${c.line} (${c.mutador}) expr=${c.expr}`),
        [],
        'hay call sites cuyo authorizedBy no se pudo resolver estáticamente: si se ' +
        'introdujo una forma nueva (valor calculado, import externo), este test tiene ' +
        'que aprender a leerla — no se puede validar lo que no se resuelve.',
    );
});

test('CA-7b: ningún authorizedBy fuera de AUTHORIZED_BY_ENUM salvo los 2 desvíos de #5165', () => {
    const infractores = CALL_SITES.filter(c => !esValorDeEnum(c.value));

    const noDeclarados = infractores.filter(c =>
        !DESVIOS_5165.some(d => d.file === c.file && d.value === c.value));

    assert.deepEqual(
        noDeclarados.map(c => `${c.file}:${c.line} (${c.mutador}) authorizedBy=${c.value}`),
        [],
        'DESVÍO NO DECLARADO: estos call sites usan un authorizedBy fuera del enum ' +
        'cerrado de partial-pause-audit y NO son uno de los 2 desvíos conocidos de ' +
        '#5165. Usá un valor del enum (no un genérico tipo "migration"/"system"), o ' +
        'si es deuda legítima, decidila en un issue antes de declararla acá.',
    );
});

test('CA-7b: la lista de desvíos conocidos no crece, no se achica y no cambia de valor', () => {
    const encontrados = CALL_SITES
        .filter(c => !esValorDeEnum(c.value))
        .map(c => `${c.file} => ${c.value}`);

    const declarados = DESVIOS_5165.map(d => `${d.file} => ${d.value}`);

    // Comparación por conjunto: el mismo desvío puede aparecer en más de una línea.
    const setEncontrados = [...new Set(encontrados)].sort();
    const setDeclarados = [...new Set(declarados)].sort();

    assert.deepEqual(
        setEncontrados,
        setDeclarados,
        'La lista cerrada de desvíos de #5165 dejó de coincidir con la realidad.\n' +
        '  - Si CRECIÓ: un tercer escritor quedó fuera del enum. Eso NO se declara acá ' +
        'sin decisión de producto — es deuda nueva de audit trail.\n' +
        '  - Si SE ACHICÓ: el desvío ya se arregló (probablemente en #5165). Sacalo de ' +
        'DESVIOS_5165 para que la deuda no quede declarada de más.\n' +
        '  - Si CAMBIÓ DE VALOR: el authorizedBy del call site se modificó sin actualizar ' +
        'la lista. La deuda no puede mutar en silencio.',
    );
});

test('los 2 desvíos declarados siguen siendo exactamente los de product-executor.js', () => {
    // Fija la identidad de la deuda (no sólo la cantidad): si #5165 mueve uno de
    // estos call sites a otro archivo, el test lo hace explícito.
    assert.equal(DESVIOS_5165.length, 2);
    for (const d of DESVIOS_5165) {
        assert.equal(d.file, 'lib/commander/product-executor.js');
    }
});

test('el enum de kernel-actions-audit NO contamina el recorrido (D2)', () => {
    // `scripts/init-waves-from-partial.js` audita con `kernel-actions-audit`, cuyo
    // enum propio incluye `kernel:auto`. Ese call site no pertenece al conjunto
    // validado: ni se evalúa ni se declara como desvío.
    assert.ok(
        !ESCRITORES_MIGRADOS.includes('scripts/init-waves-from-partial.js'),
        'el seed no debe entrar al recorrido: entra a #5179 por el eje path-level, ' +
        'no como escritor de partial-pause',
    );
    assert.ok(
        !CALL_SITES.some(c => c.value === 'kernel:auto'),
        'apareció kernel:auto en el recorrido: se están mezclando dos enums independientes',
    );
    // Y `kernel:auto` efectivamente NO pertenece al enum de partial-pause.
    assert.ok(!audit.AUTHORIZED_BY_STATIC.includes('kernel:auto'));
});
