// Tests de hasVisualReference (issue #3383, CA-16).
//
// Cubre los 7 casos del CA-16 + bordes de seguridad:
//   1. Sección presente con 2 imágenes → ok:true
//   2. Sección presente con 1 imagen → ok:false, reason 'needs-at-least-2-images'
//   3. Sección presente sin imágenes → ok:false, reason 'no-images'
//   4. Sección ausente → ok:false, reason 'section-missing'
//   5. Issue con qa:skipped → ok:true bypass independientemente del contenido
//   6. Body > 100KB → truncado controlado, no cuelga
//   7. Regex no es ReDoSable (input adversarial documentado)
//
// Plus: variantes case-insensitive y separadores '&' / 'y' / 'and' (CA-UX-3).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    hasVisualReference,
    truncateBody,
    hasQaSkippedLabel,
    extractSectionSlice,
    MAX_BODY_BYTES,
} = require('../lib/qa-evidence-gate');

// ----- CA-1 / CA-16: sección presente con 2 imágenes → ok ------------------

test('CA-16/1 sección con 2 imágenes adjuntas retorna ok:true', () => {
    const body = [
        '## Objetivo',
        'Pantalla onboarding paso 2.',
        '',
        '## Screenshots & Mockups',
        '![mockup esperado](https://user-attachments.githubusercontent.com/1/m.png)',
        '![entrega actual](https://user-attachments.githubusercontent.com/1/e.png)',
        '',
        '## Criterios',
        '- algo',
    ].join('\n');
    const r = hasVisualReference(body);
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'has-visual-reference');
    assert.equal(r.images, 2);
});

test('CA-16/1b la sección puede tener más de 2 imágenes', () => {
    const body = [
        '## Screenshots & Mockups',
        '![a](x://1.png)',
        '![b](x://2.png)',
        '![c](x://3.png)',
        '![d](x://4.png)',
    ].join('\n');
    const r = hasVisualReference(body);
    assert.equal(r.ok, true);
    assert.ok(r.images >= 2);
});

// ----- CA-16/2: sección con 1 imagen → fail --------------------------------

test('CA-16/2 sección con 1 sola imagen retorna ok:false con reason needs-at-least-2-images', () => {
    const body = [
        '## Screenshots & Mockups',
        '![mockup](https://example.com/m.png)',
    ].join('\n');
    const r = hasVisualReference(body);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'needs-at-least-2-images');
    assert.equal(r.images, 1);
});

// ----- CA-16/3: sección sin imágenes → fail --------------------------------

test('CA-16/3 sección sin imágenes retorna ok:false reason no-images', () => {
    const body = [
        '## Screenshots & Mockups',
        '',
        'Voy a agregar las imágenes después.',
    ].join('\n');
    const r = hasVisualReference(body);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-images');
    assert.equal(r.images, 0);
});

// ----- CA-16/4: sección ausente → fail -------------------------------------

test('CA-16/4 body sin sección retorna ok:false reason section-missing', () => {
    const body = [
        '## Objetivo',
        '![algo](x://no-importa.png)',
        '![otro](x://no-importa2.png)',
        '## Criterios',
    ].join('\n');
    const r = hasVisualReference(body);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'section-missing');
});

test('CA-16/4b body vacío retorna ok:false reason empty-body', () => {
    assert.deepEqual(hasVisualReference(''), { ok: false, reason: 'empty-body' });
    assert.deepEqual(hasVisualReference(null), { ok: false, reason: 'empty-body' });
    assert.deepEqual(hasVisualReference(undefined), { ok: false, reason: 'empty-body' });
});

// ----- CA-16/5: bypass qa:skipped (CA-3) -----------------------------------

test('CA-16/5 issue con label qa:skipped bypassa el gate', () => {
    const body = 'no tiene sección ni imágenes';
    const r = hasVisualReference(body, { labels: ['qa:skipped'] });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'qa-skipped');
});

test('CA-16/5b qa:skipped funciona también con shape {name}', () => {
    const r = hasVisualReference('', { labels: [{ name: 'qa:skipped' }, { name: 'app:client' }] });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'qa-skipped');
});

test('CA-16/5c qa:skipped es case-insensitive', () => {
    const r = hasVisualReference('', { labels: ['QA:Skipped'] });
    assert.equal(r.ok, true);
});

test('hasQaSkippedLabel rechaza labels inválidas sin explotar', () => {
    assert.equal(hasQaSkippedLabel(null), false);
    assert.equal(hasQaSkippedLabel(undefined), false);
    assert.equal(hasQaSkippedLabel('qa:skipped'), false); // no es array
    assert.equal(hasQaSkippedLabel([null, undefined, 42, {}, { name: 'other' }]), false);
});

// ----- CA-16/6: body > 100KB truncado controlado ---------------------------

test('CA-16/6 body > 100KB se trunca antes de parsear y no cuelga', () => {
    // 200KB de relleno + sección al final (queda truncada).
    const filler = 'a'.repeat(200 * 1024);
    const body = filler + '\n## Screenshots & Mockups\n![m](x://1.png)\n![e](x://2.png)\n';
    const t0 = Date.now();
    const r = hasVisualReference(body);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, `parse tardó ${elapsed}ms — debe ser <500ms incluso con body grande`);
    // La sección quedó truncada → debe fallar como section-missing.
    assert.equal(r.ok, false);
});

test('CA-16/6b body justo en el límite se procesa', () => {
    const padding = 'x '.repeat(40000); // ~80KB
    const body = padding + '\n## Screenshots & Mockups\n![m](x://1.png)\n![e](x://2.png)\n';
    const r = hasVisualReference(body);
    assert.equal(r.ok, true);
});

test('truncateBody respeta MAX_BODY_BYTES', () => {
    const big = 'z'.repeat(MAX_BODY_BYTES + 1000);
    const out = truncateBody(big);
    assert.ok(Buffer.byteLength(out, 'utf8') <= MAX_BODY_BYTES);
});

// ----- CA-16/7: adversarial ReDoS ------------------------------------------

test('CA-16/7 input adversarial ReDoS no cuelga (terminación en <500ms)', () => {
    // Patrón clásico catastrophic backtracking en regex no-bounded:
    //   "![" + "a".repeat(N) + "(" sin ")".
    // Nuestro regex usa [^\]]/[^)] y exec en loop — debe terminar lineal.
    const adversarial = '## Screenshots & Mockups\n' + '!['.repeat(5000) + 'aaaa';
    const t0 = Date.now();
    const r = hasVisualReference(adversarial);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, `parse adversarial tardó ${elapsed}ms — posible ReDoS`);
    assert.equal(r.ok, false); // no encuentra imágenes válidas
});

test('CA-16/7b adversarial con muchos brackets anidados no cuelga', () => {
    const adversarial = '## Screenshots & Mockups\n' + ('![alt'.repeat(2000)) + '\n';
    const t0 = Date.now();
    const r = hasVisualReference(adversarial);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, `parse tardó ${elapsed}ms`);
    assert.equal(r.ok, false);
});

// ----- CA-UX-3: case-insensitive + variantes de separador ------------------

test('CA-UX-3 acepta variante "Screenshots y Mockups" (español)', () => {
    const body = [
        '## Screenshots y Mockups',
        '![m](x://1.png)',
        '![e](x://2.png)',
    ].join('\n');
    const r = hasVisualReference(body);
    assert.equal(r.ok, true);
});

test('CA-UX-3 acepta variante "Screenshots and Mockups"', () => {
    const body = [
        '## Screenshots and Mockups',
        '![m](x://1.png)',
        '![e](x://2.png)',
    ].join('\n');
    const r = hasVisualReference(body);
    assert.equal(r.ok, true);
});

test('CA-UX-3 acepta header case-insensitive', () => {
    const body = [
        '## SCREENSHOTS & MOCKUPS',
        '![m](x://1.png)',
        '![e](x://2.png)',
    ].join('\n');
    const r = hasVisualReference(body);
    assert.equal(r.ok, true);
});

test('CA-UX-3 acepta header con # adicionales (### o ####)', () => {
    const body = [
        '### Screenshots & Mockups',
        '![m](x://1.png)',
        '![e](x://2.png)',
    ].join('\n');
    const r = hasVisualReference(body);
    assert.equal(r.ok, true);
});

test('imágenes después del siguiente header NO cuentan', () => {
    const body = [
        '## Screenshots & Mockups',
        '![solo-una](x://1.png)',
        '',
        '## Criterios',
        '![otra-fuera-de-seccion](x://2.png)',
        '![otra-mas](x://3.png)',
    ].join('\n');
    const r = hasVisualReference(body);
    assert.equal(r.ok, false);
    assert.equal(r.images, 1);
});

// ----- extractSectionSlice helper -----------------------------------------

test('extractSectionSlice corta exactamente entre headers', () => {
    const body = [
        '## A',
        'aa',
        '## Screenshots & Mockups',
        'imgs',
        '![m](x://1.png)',
        '## B',
        'bb',
    ].join('\n');
    const slice = extractSectionSlice(body);
    assert.ok(slice.includes('imgs'));
    assert.ok(slice.includes('![m](x://1.png)'));
    assert.ok(!slice.includes('bb'));
});
