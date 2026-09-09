// Tests de la guarda del barrido de huérfanos (incidente 2026-09-08).
//
// El caso que reproducen es el real: el Pulpo reinició a las 10:09:23 y a las
// 10:09:43 empezó a rebotar fases sanas, porque el dropfile heredaba un mtime
// de 592 minutos y el registro de corridas estaba vacío tras el boot.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const orphanGuard = require('../lib/orphan-guard');

test('una corrida joven nunca es huérfana', () => {
    const r = orphanGuard.decidirHuerfano({
        ageMinutes: 3,
        timeoutMinutes: 10,
        registroConocido: false,
        procesoVivo: false,
        minutosDesdeBoot: 600,
    });
    assert.equal(r.huerfano, false);
    assert.equal(r.motivo, orphanGuard.MOTIVOS.JOVEN);
});

test('una corrida vieja con proceso vivo no es huérfana', () => {
    const r = orphanGuard.decidirHuerfano({
        ageMinutes: 90,
        timeoutMinutes: 10,
        registroConocido: true,
        procesoVivo: true,
        minutosDesdeBoot: 600,
    });
    assert.equal(r.huerfano, false);
    assert.equal(r.motivo, orphanGuard.MOTIVOS.PROCESO_VIVO);
});

test('el caso del incidente: registro frío tras el reinicio NO rebota la fase', () => {
    // Exactamente lo que pasó: dropfile con 592 min de mtime heredado, registro
    // vacío porque el Pulpo acababa de bootear 20 segundos antes.
    const r = orphanGuard.decidirHuerfano({
        ageMinutes: 592,
        timeoutMinutes: 10,
        registroConocido: false,
        procesoVivo: false,
        minutosDesdeBoot: 20 / 60,
    });
    assert.equal(r.huerfano, false, 'con el registro frío el barrido debe abstenerse');
    assert.equal(r.motivo, orphanGuard.MOTIVOS.GRACIA_POST_BOOT);
});

test('pasada la gracia, una corrida vieja sin proceso sí es huérfana', () => {
    const r = orphanGuard.decidirHuerfano({
        ageMinutes: 592,
        timeoutMinutes: 10,
        registroConocido: false,
        procesoVivo: false,
        minutosDesdeBoot: 120,
    });
    assert.equal(r.huerfano, true);
    assert.equal(r.motivo, orphanGuard.MOTIVOS.HUERFANO);
});

test('un proceso conocido pero muerto es huérfano aunque el Pulpo recién arranque', () => {
    // La gracia cubre el DESCONOCIMIENTO, no la muerte confirmada: si lo tenemos
    // registrado y el PID no vive, la señal es inequívoca.
    const r = orphanGuard.decidirHuerfano({
        ageMinutes: 45,
        timeoutMinutes: 10,
        registroConocido: true,
        procesoVivo: false,
        minutosDesdeBoot: 1,
    });
    assert.equal(r.huerfano, true);
    assert.equal(r.motivo, orphanGuard.MOTIVOS.HUERFANO);
});

test('marcarEntradaEnTrabajando pone el mtime en ahora', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-guard-'));
    const file = path.join(dir, '5801.pipeline-dev');
    fs.writeFileSync(file, 'issue: 5801\n');

    // Simulamos el dropfile que estuvo horas en `pendiente/`.
    const hace10Horas = new Date(Date.now() - 600 * 60000);
    fs.utimesSync(file, hace10Horas, hace10Horas);
    const edadAntes = (Date.now() - fs.statSync(file).mtimeMs) / 60000;
    assert.ok(edadAntes > 500, 'precondición: el dropfile nace vencido');

    const ok = orphanGuard.marcarEntradaEnTrabajando(file);
    assert.equal(ok, true);

    const edadDespues = (Date.now() - fs.statSync(file).mtimeMs) / 60000;
    assert.ok(edadDespues < 1, `tras marcar la entrada la corrida debe ser joven, fue ${edadDespues}`);

    fs.rmSync(dir, { recursive: true, force: true });
});

test('marcarEntradaEnTrabajando no rompe si el archivo no existe', () => {
    const ok = orphanGuard.marcarEntradaEnTrabajando('/no/existe/jamas.yaml');
    assert.equal(ok, false);
});
