// =============================================================================
// credential-death-wiring-6238.test.js — Issue #6238.
//
// El brazo de `credential-death` vive dentro del `child.on('exit')` del Pulpo:
// un closure de varios miles de líneas que no se puede invocar en aislamiento
// sin levantar un agente real. Lo que SÍ se puede afirmar de forma determinística
// es el CABLEADO, y es justo donde vivían los defectos que esta historia arregla
// (penalizar al issue, leer un archivo nuevo, disparar el PDF de rebote).
//
// Esta suite verifica por inspección del fuente:
//   CA-3 · el brazo NO llama a registerFastFail, NO dispara rejection-report,
//          devuelve el archivo a `pendiente/` y limpia recursos.
//   CA-8 · el `logTail` sale del contenido ya cargado (`agentLogRaw`), no de un
//          `readFileSync` nuevo, y se pasa acotado con `slice`.
//   CA-4 · el apagado del provider usa threshold 1, TTL y source credential-death.
//   CA-5 · el aviso se emite por `sendCredentialDeathNotif` (deduplicado) y la
//          línea de log se emite SIEMPRE (fuera de cualquier rama del dedupe).
//   CA-6 · la línea de auditoría se escribe siempre, sin raw_excerpt.
//   CA-1 · el brazo de credencial precede al de provider-death.
//
// Ejecución: `node --test .pipeline/tests/credential-death-wiring-6238.test.js`
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PULPO = path.join(__dirname, '..', 'pulpo.js');
const SRC = fs.readFileSync(PULPO, 'utf8');

// Extrae el cuerpo del brazo `credential-death` por conteo de llaves, desde el
// `if (!hasVerdict && deathKind === 'credential-death') {` hasta su cierre.
function credentialArm() {
    const marker = "if (!hasVerdict && deathKind === 'credential-death') {";
    const start = SRC.indexOf(marker);
    assert.notEqual(start, -1, 'el brazo de credential-death debe existir en pulpo.js');
    let depth = 0;
    let i = SRC.indexOf('{', start);
    const from = i;
    for (; i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}') {
            depth--;
            if (depth === 0) return SRC.slice(from, i + 1);
        }
    }
    throw new Error('no se pudo delimitar el brazo de credential-death');
}

const ARM = credentialArm();

test('CA-1 el brazo de credential-death precede al de provider-death', () => {
    const cred = SRC.indexOf("deathKind === 'credential-death'");
    const prov = SRC.indexOf("deathKind === 'provider-death'");
    assert.notEqual(cred, -1);
    assert.notEqual(prov, -1);
    assert.ok(cred < prov, 'credential-death debe evaluarse antes que provider-death');
});

test('CA-3 el brazo NO penaliza al issue: sin registerFastFail y sin cooldown', () => {
    assert.ok(!ARM.includes('registerFastFail'), 'no puede llamar a registerFastFail');
    assert.ok(!/\bregisterCooldown\b|\bsetCooldown\b/.test(ARM), 'no puede aplicar cooldown al (skill,issue)');
});

test('CA-3 el brazo NO dispara el PDF de rebote (el issue no falló)', () => {
    assert.ok(!ARM.includes('rejection-report'), 'no puede disparar rejection-report.js');
});

test('CA-3 el archivo vuelve a pendiente/ y se limpian los recursos', () => {
    assert.ok(/moveFile\(trabajandoPath,\s*pendienteDir\)/.test(ARM), 'debe devolver el archivo a pendiente/');
    assert.ok(ARM.includes('activeProcesses.delete'), 'debe soltar el proceso activo');
    assert.ok(ARM.includes('killGradleDaemonsForCwd'), 'debe matar los daemons de Gradle');
    assert.ok(ARM.includes('leaveChannelByType'), 'debe salir del canal de contexto');
    assert.ok(/\breturn;\s*$/m.test(ARM), 'debe cortar el flujo (no caer al fast-fail de abajo)');
});

test('CA-4 el apagado del provider usa threshold 1, TTL acotado y source credential-death', () => {
    assert.ok(ARM.includes('recordProviderSpawnDeath'), 'debe registrar la muerte a nivel provider');
    assert.ok(/threshold:\s*1/.test(ARM), 'una credencial vencida apaga con UNA muerte');
    assert.ok(/disableTtlMs:\s*60\s*\*\s*60\s*\*\s*1000/.test(ARM), 'TTL de 60 min');
    assert.ok(/source:\s*'credential-death'/.test(ARM), "el disable debe llevar source 'credential-death'");
});

test('CA-5 el aviso al operador es el deduplicado, y la línea de log se emite siempre', () => {
    assert.ok(ARM.includes('sendCredentialDeathNotif'), 'debe usar el aviso deduplicado');
    // El log NO puede estar dentro de un `if (notif.sent)`: la evidencia se
    // emite en todas las muertes, incluidas las suprimidas (SEC-CA-4).
    assert.ok(!/if\s*\(\s*notif\.sent\s*\)/.test(ARM), 'el log no puede depender de que el aviso se haya enviado');
    assert.ok(ARM.includes("log('lanzamiento'"), 'debe dejar línea de log');
    // CA-UX-9: la línea dice si el aviso se suprimió y cuánto falta.
    assert.ok(/suprimido por cooldown/.test(ARM));
    assert.ok(/remainingMin/.test(ARM));
    // El brazo NO llama a sendTelegram directo (saltearía el dedupe).
    assert.ok(!/\bsendTelegram\(/.test(ARM), 'el aviso debe pasar por el dedupe, no por sendTelegram directo');
});

test('CA-6 la auditoría se escribe siempre y sin raw_excerpt', () => {
    assert.ok(ARM.includes('appendSpawnExitDeathKind'), 'debe escribir la línea death_kind');
    // (La palabra puede aparecer en un comentario del brazo; lo prohibido es
    // que se PASE como campo.)
    assert.ok(!/raw_excerpt\s*:/.test(ARM), 'el brazo no puede pasar raw_excerpt como campo');
    assert.ok(!/rawOutput\s*:/.test(ARM), 'el brazo no puede pasar el output crudo');
    // La auditoría va ANTES del aviso: el dedupe no puede saltearla.
    assert.ok(ARM.indexOf('appendSpawnExitDeathKind') < ARM.indexOf('sendCredentialDeathNotif'),
        'la auditoría debe emitirse antes del aviso deduplicado');
});

test('CA-8 el logTail sale del contenido ya cargado, no de un archivo nuevo', () => {
    // El clasificador recibe una cola acotada de `agentLogRaw`.
    assert.ok(/logTail:\s*agentLogRaw\s*\?\s*agentLogRaw\.slice\(-32\s*\*\s*1024\)/.test(SRC),
        'logTail debe salir de agentLogRaw.slice(-32*1024)');
    // `agentLogRaw` se declara ANTES del bloque que lo llena y del que lo usa.
    const decl = SRC.indexOf("let agentLogRaw = ''");
    const assign = SRC.indexOf('agentLogRaw = raw;');
    const use = SRC.indexOf('logTail: agentLogRaw');
    assert.ok(decl !== -1 && assign !== -1 && use !== -1);
    assert.ok(decl < assign && assign < use, 'orden: declaración → asignación → uso');
});

test('CA-8 no se abre ningún archivo nuevo para clasificar la muerte prematura', () => {
    assert.ok(!/readFileSync/.test(ARM), 'el brazo no puede leer archivos');
    assert.ok(!/attempt-/.test(ARM), 'el brazo no puede tocar los .attempt-N.log (#6245)');
});

test('CA-1 el Pulpo no decide credential-death por texto libre', () => {
    // Toda la decisión vive en el detector estructural. Ninguna comparación
    // textual sobre el log puede aparecer en pulpo.js para esta causa.
    assert.ok(!SRC.includes('OAuth session expired'),
        'pulpo.js no puede matchear la frase de error');
    assert.ok(!/agentLogRaw\.includes\(/.test(SRC),
        'pulpo.js no puede hacer substring sobre el log del agente');
});

test('CA-10 la clasificación no depende del feature flag del parser generalizado', () => {
    // `agentLogRaw` se llena fuera de la rama del flag: la asignación ocurre
    // antes de consultar `isGeneralizedParserEnabled()`.
    const assign = SRC.indexOf('agentLogRaw = raw;');
    const flag = SRC.indexOf('dispatcher.isGeneralizedParserEnabled()');
    assert.ok(assign !== -1 && flag !== -1);
    assert.ok(assign < flag, 'agentLogRaw se llena antes de evaluar el feature flag');
});
