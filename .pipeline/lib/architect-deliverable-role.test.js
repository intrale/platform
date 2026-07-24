'use strict';

// Guard anti-regresión (#4516): el rol del Arquitecto DEBE instruir la
// producción SIEMPRE del dictamen de integridad técnica en el cierre de la
// Fase 2 (`aprobacion`) vía el punto de escritura único `writeDeliverable`.
//
// No es lógica de negocio — es un guard estático que evita que una futura
// edición borre el paso obligatorio (CA-1/CA-3) o desincronice el rol
// operativo (`.pipeline/roles/architect.md`) de la doc canónica
// (`docs/pipeline/architect-role.md`).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROLE_PATH = path.join(__dirname, '..', 'roles', 'architect.md');
const DOC_PATH = path.join(__dirname, '..', '..', 'docs', 'pipeline', 'architect-role.md');

function readRole() {
    return fs.readFileSync(ROLE_PATH, 'utf8');
}

function readDoc() {
    return fs.readFileSync(DOC_PATH, 'utf8');
}

test('el rol architect instruye writeDeliverable del dictamen en Fase 2', () => {
    const md = readRole();
    // La llamada explícita al punto único debe estar presente (CA-1/CA-3).
    assert.ok(
        md.includes("writeDeliverable('architect'"),
        'architect.md debe instruir writeDeliverable(\'architect\', ...) en el cierre de Fase 2',
    );
});

test('la llamada writeDeliverable vive dentro de la sección de Fase 2 (aprobacion)', () => {
    const md = readRole();
    const fase2Idx = md.indexOf('En pipeline de desarrollo (fase: aprobacion) — Fase 2');
    assert.ok(fase2Idx !== -1, 'debe existir la sección de Fase 2 (aprobacion)');
    const writeIdx = md.indexOf("writeDeliverable('architect'");
    assert.ok(
        writeIdx > fase2Idx,
        'la instrucción writeDeliverable debe ubicarse dentro de la sección de Fase 2',
    );
});

test('el dictamen declara las 4 secciones obligatorias (CA-2)', () => {
    const md = readRole();
    for (const seccion of [
        'Adherencia al diseño/diagramas',
        'Desvíos vs. diseño',
        'Deuda técnica / riesgos introducidos',
        'Integridad estructural',
    ]) {
        assert.ok(
            md.includes(seccion),
            `architect.md debe declarar la sección obligatoria del dictamen: "${seccion}"`,
        );
    }
});

test('el rol cubre la rama de excepción explícita N/A (CA-5)', () => {
    const md = readRole();
    assert.ok(
        md.includes('N/A — no aplica dictamen técnico'),
        'architect.md debe declarar la rama de excepción explícita (N/A + motivo) para CA-5',
    );
});

test('la doc canónica queda sincronizada con el dictamen obligatorio (anti-drift)', () => {
    const doc = readDoc();
    assert.ok(
        doc.includes("writeDeliverable('architect'") &&
            doc.includes('Dictamen de integridad técnica'),
        'docs/pipeline/architect-role.md debe reflejar el dictamen obligatorio para no desincronizarse del rol',
    );
});
