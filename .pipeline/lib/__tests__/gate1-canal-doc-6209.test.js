// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const doc = fs.readFileSync(path.join(root, 'docs/pipeline/gates-firma-operador.md'), 'utf8');
const ensayo = fs.readFileSync(path.join(root, 'docs/pipeline/gate1-ensayo-6209.md'), 'utf8');
const canal = doc.split('## 15. Canal de aprobación unificado')[1]?.split('## Escapes de referencia')[0];

test('la sección 15 reconcilia el canal integrado con la sección 14', () => {
    assert.ok(canal);
    assert.match(canal, /§14/);
    assert.match(canal, /gate1-ensayo-6209\.md/);
    assert.doesNotMatch(doc, /#6207, todavía sin implementar|no levanta por sí solo/);
    for (const api of ['requestSignature', 'submitSignature', 'listPending']) {
        assert.ok(canal.includes(api));
        assert.equal(typeof require('../approval-channel')[api], 'function');
    }
});

test('documenta los medios sin atribuir firma al dashboard ni habilitar transporte remoto', () => {
    assert.match(canal, /Telegram porta la identidad humana/);
    assert.match(canal, /dashboard local[\s\S]*no representa una identidad firmante/);
    assert.match(canal, /no firma ni llama writers/);
    assert.match(canal, /mobile-ready/);
    assert.match(canal, /el transporte remoto no está habilitado/);
});

test('enumera los seis invariantes de autoridad obligatorios para nuevos gates', () => {
    for (const rule of [
        /1\. Autorización \*\*revalidada al ejecutar/,
        /2\. \*\*Fail-closed\*\* ante allowlist vacía, ausente o fallo/,
        /3\.[\s\S]*server-side/,
        /4\. Token \*\*de un solo uso\*\*, con autorización validada antes/,
        /5\. Firma en \*\*audit chain con integridad\*\*/,
        /6\.[\s\S]*no se persisten ni se loguean/,
    ]) assert.match(canal, rule);
});

test('la receta separa autorización, observación, ensayo global y encendido permanente', () => {
    for (const rule of [
        /máximo\s+30 minutos/,
        /Sin respuesta explícita no se inicia/,
        /Contar issues distintos/,
        /no deposita pedidos ni prueba retención/,
        /Si el conteo supera 15, abortar/,
        /pausa parcial no filtra el barrido/,
        /override local NO commiteado/,
        /clearFullPause/,
        /No usar `\/reanudar`/,
        /Sólo el operador pulsa Aprobar/,
        /firma, con botones/,
        /pausar globalmente ANTES de restaurar/,
        /Conservar la pausa global mientras queden pendientes/,
        /rollback no implica resume/,
        /commit separado y último del PR/,
        /Un fallo del ensayo deja CA-D3 abierto/,
    ]) assert.match(ensayo, rule);
});

test('registra el ensayo fallido por precondición del vault y el traslado de CA-D3 a #7273', () => {
    // Re-alcance del operador (2026-09-16): el flip a enforce vive en #7273 y este
    // issue cierra con el gate idéntico a main. La doc no puede seguir presentando
    // el commit definitivo como cierre de #6209 ni omitir por qué falló el ensayo.
    for (const text of [ensayo, canal]) {
        assert.match(text, /#7273/);
        assert.match(text, /VAULT_DISABLED/);
        assert.match(text, /telegram\.bot_token/);
        assert.match(text, /`enabled: false`[\s\S]{0,40}`gate_mode: dry-run`/);
    }
    assert.match(ensayo, /falló por precondición/);
    assert.match(ensayo, /indeterminado, sin botones/);
    assert.match(ensayo, /#7117/);
    // El registro es un resultado observado, no una autorización nueva ni una firma.
    assert.doesNotMatch(ensayo, /firma (real|humana) (obtenida|registrada|verificada)/i);
});

test('la documentación pública no contiene identificadores secretos ni rutas privadas', () => {
    for (const text of [doc, ensayo]) {
        assert.doesNotMatch(text, /\b[0-9a-f]{16}\b|\b[0-9a-f]{64}\b/i);
        assert.doesNotMatch(text, /[A-Z]:[\\/]|\/home\/|\/Users\//);
        assert.doesNotMatch(text, /\bchat_id\s*[:=]\s*['"]?\d{6,}/i);
    }
});
