// =============================================================================
// multimedia-free-stack.test.js — EP1-H2 (#3917)
//
// Cubre el stack multimedia 100% gratuito:
//   - TTS: Edge motor oficial y único (loadTtsConfig normaliza cualquier perfil
//     legacy a edge/null; ya no expone openai/intros).
//   - getTransitionIntro: sin transiciones de personaje → siempre null.
//   - Superficie de módulo: ya no exporta textToSpeechOpenAI ni transcribeAudio.
//   - Seguridad (req #3): sanitizeForTts redacta secretos antes de cualquier
//     ruta a Edge.
//
// node:test (built-in). Requerir multimedia.js no dispara side effects (igual
// que split-text-for-tts-chunks.test.js).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mm = require('../multimedia');

test('loadTtsConfig(default): Edge es primary y fallback null (motor único)', () => {
    const cfg = mm.loadTtsConfig('default');
    assert.equal(cfg.primary, 'edge', 'el primary debe ser edge');
    assert.equal(cfg.fallback, null, 'no debe haber fallback (motor único)');
    assert.ok(cfg.edge && cfg.edge.voice, 'debe traer la config edge con voz');
});

test('loadTtsConfig: ya no expone provider openai ni intros (Claudito retirado)', () => {
    const cfg = mm.loadTtsConfig('default');
    assert.equal(cfg.openai, undefined, 'no debe exponer config openai');
    assert.equal(cfg.intros, undefined, 'no debe exponer intros de transición');
});

test('loadTtsConfig: perfil inexistente cae a default (edge), nunca a un motor pago', () => {
    // Con `profiles.default` presente, un perfil desconocido reusa esa config:
    // lo relevante es que jamás caiga a un motor pago.
    const cfg = mm.loadTtsConfig('__no_existe__');
    assert.equal(cfg.primary, 'edge');
    assert.equal(cfg.fallback, null);
    assert.ok(cfg.edge && cfg.edge.voice, 'debe traer la config edge heredada del default');
});

test('loadTtsConfig: todos los perfiles reales quedan en edge/null', () => {
    // Recorre el archivo real para garantizar que ningún perfil declare un motor
    // pago. Si alguien agrega un perfil con primary openai, este test lo caza.
    const cfgPath = require('path').join(__dirname, '..', 'tts-config.json');
    const raw = JSON.parse(require('fs').readFileSync(cfgPath, 'utf8'));
    const names = Object.keys(raw.profiles || {});
    assert.ok(names.length >= 1, 'debe haber al menos un perfil');
    for (const name of names) {
        const cfg = mm.loadTtsConfig(name);
        assert.equal(cfg.primary, 'edge', `perfil ${name} debe ser edge`);
        assert.equal(cfg.fallback, null, `perfil ${name} no debe tener fallback`);
    }
});

test('getTransitionIntro: con motor único siempre retorna null', () => {
    // Aunque pidan una transición openai↔edge (config vieja), no hay intro.
    assert.equal(mm.getTransitionIntro('openai', 'edge'), null);
    assert.equal(mm.getTransitionIntro('edge', 'openai'), null);
    assert.equal(mm.getTransitionIntro('edge', 'edge'), null);
    assert.equal(mm.getTransitionIntro('edge', null), null);
});

test('superficie de módulo: sin textToSpeechOpenAI ni transcribeAudio (rutas pagas retiradas)', () => {
    assert.equal(typeof mm.textToSpeechOpenAI, 'undefined', 'textToSpeechOpenAI debe estar retirada');
    assert.equal(typeof mm.transcribeAudio, 'undefined', 'transcribeAudio (API) debe estar retirada');
    // Lo que SÍ debe seguir existiendo (contrato vivo):
    assert.equal(typeof mm.textToSpeechEdge, 'function', 'textToSpeechEdge debe existir');
    assert.equal(typeof mm.transcribeAudioWithFallback, 'function', 'transcribeAudioWithFallback debe existir');
    assert.equal(typeof mm.transcriptionFailureMessage, 'function', 'transcriptionFailureMessage debe existir');
});

test('transcriptionFailureMessage: mensajes hablan del motor local, sin "cuota/key OpenAI"', () => {
    const msgs = ['unavailable', 'no_binary', 'cli_error', 'timeout', 'spawn_error', 'cualquiera']
        .map((k) => mm.transcriptionFailureMessage(k));
    for (const m of msgs) {
        // El criterio prohíbe referencias a la API paga ("cuota OpenAI"/"key
        // OpenAI"/api.openai.com). El nombre del paquete open-source
        // `openai-whisper` NO es una referencia a la API paga y está permitido.
        assert.ok(!/cuota OpenAI/i.test(m), 'no debe mencionar "cuota OpenAI": ' + m);
        assert.ok(!/key OpenAI/i.test(m), 'no debe mencionar "key OpenAI": ' + m);
        assert.ok(!/api\.openai/i.test(m), 'no debe mencionar el endpoint pago: ' + m);
    }
    // El mensaje de motor ausente menciona el remedio local (whisper).
    assert.match(mm.transcriptionFailureMessage('no_binary'), /whisper/i);
});

test('seguridad (req #3): sanitizeForTts redacta secretos antes de ir a Edge', () => {
    const awsKey = 'AKIA' + 'ABCDEFGHIJ123456'; // patrón sintético AWS access key
    const jwt = 'eyJ' + 'abcdefghij' + '.' + 'klmnopqrst' + '.' + 'uvwxyz0123';
    const out = mm.sanitizeForTts(`Mi key es ${awsKey} y el token ${jwt} listo`);
    assert.ok(!out.includes(awsKey), 'la AWS key no debe sobrevivir al sanitizador');
    assert.ok(!out.includes(jwt), 'el JWT no debe sobrevivir al sanitizador');
});
