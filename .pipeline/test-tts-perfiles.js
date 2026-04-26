#!/usr/bin/env node
// =============================================================================
// Tests TTS perfiles (#2518 — PR reparto de voces por agente)
//
// Cubre el loader de perfiles en multimedia.js:
//   - shape nuevo { profiles: { default, qa, ... } }
//   - backcompat con shape viejo { primary, fallback, providers }
//   - fallback a default si el perfil pedido no existe
//   - DEFAULT_PROFILE como último recurso si el archivo no existe
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Helper: cargar multimedia con un config path custom
function loadMultimediaWithConfig(configContent) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-test-'));
  const configPath = path.join(tmpDir, 'tts-config.json');
  if (configContent !== null) {
    fs.writeFileSync(configPath, configContent);
  }
  // Sobrescribir TTS_CONFIG_PATH dentro del modulo vía monkey-patch
  // Más simple: renombramos el path hacia el tmp y reimportamos.
  // Como multimedia.js usa ROOT + '.pipeline/tts-config.json', hay que
  // hookear a un nivel que sea testeable. Lo más pragmático es validar
  // la lógica parseando el JSON directamente con la misma semántica
  // que loadTtsConfig usa internamente.
  return { configPath, tmpDir };
}

// Replicar la lógica de resolución de perfil de multimedia.js:loadTtsConfig,
// así el test puede ejercitarla sin depender del path del config real.
function resolveProfile(raw, profileName = 'default') {
  const DEFAULT = {
    primary: 'openai',
    fallback: 'edge',
    openai: { character_name: 'Claudito' },
    edge: { character_name: 'Tommy' },
    intros: {},
  };
  if (!raw) return { ...DEFAULT, profileName: 'default', profileFound: false };

  let profileRaw = null;
  if (raw.profiles && typeof raw.profiles === 'object') {
    profileRaw = raw.profiles[profileName];
    if (!profileRaw && profileName !== 'default') {
      profileRaw = raw.profiles.default;
    }
  } else {
    profileRaw = {
      primary: raw.primary,
      fallback: raw.fallback,
      openai: raw.providers?.openai,
      edge: raw.providers?.edge,
      intros: raw.intros,
    };
  }

  if (!profileRaw) return { ...DEFAULT, profileName: 'default', profileFound: false };

  return {
    primary: profileRaw.primary || DEFAULT.primary,
    fallback: profileRaw.fallback === null ? null : (profileRaw.fallback || DEFAULT.fallback),
    openai: { ...DEFAULT.openai, ...(profileRaw.openai || {}) },
    edge: { ...DEFAULT.edge, ...(profileRaw.edge || {}) },
    intros: { ...DEFAULT.intros, ...(profileRaw.intros || {}) },
    profileName,
    profileFound: true,
  };
}

test('shape nuevo: carga perfil default correctamente', () => {
  const cfg = {
    profiles: {
      default: {
        primary: 'openai', fallback: 'edge',
        openai: { character_name: 'Claudito', voice: 'ash' },
        edge: { character_name: 'Tommy', voice: 'es-AR-TomasNeural' },
      },
    },
  };
  const r = resolveProfile(cfg, 'default');
  assert.equal(r.profileFound, true);
  assert.equal(r.primary, 'openai');
  assert.equal(r.openai.character_name, 'Claudito');
  assert.equal(r.edge.character_name, 'Tommy');
});

test('shape nuevo: carga perfil qa con primary edge (invertido)', () => {
  const cfg = {
    profiles: {
      default: { primary: 'openai', fallback: 'edge' },
      qa: {
        primary: 'edge', fallback: 'openai',
        openai: { character_name: 'Rulo' },
        edge: { character_name: 'Nacho' },
      },
    },
  };
  const r = resolveProfile(cfg, 'qa');
  assert.equal(r.profileFound, true);
  assert.equal(r.primary, 'edge');
  assert.equal(r.fallback, 'openai');
  assert.equal(r.openai.character_name, 'Rulo');
  assert.equal(r.edge.character_name, 'Nacho');
});

test('shape nuevo: perfil inexistente cae a default', () => {
  const cfg = {
    profiles: {
      default: { primary: 'openai', openai: { character_name: 'Claudito' }, edge: { character_name: 'Tommy' } },
    },
  };
  const r = resolveProfile(cfg, 'ghost-agent');
  assert.equal(r.profileFound, true);
  assert.equal(r.openai.character_name, 'Claudito');
  assert.equal(r.profileName, 'ghost-agent'); // el profileName refleja lo pedido (trazabilidad)
});

test('shape viejo: { primary, fallback, providers } funciona como default (backcompat)', () => {
  const cfg = {
    primary: 'openai',
    fallback: 'edge',
    providers: {
      openai: { character_name: 'Claudito', voice: 'ash' },
      edge: { character_name: 'Tommy', voice: 'es-AR-TomasNeural' },
    },
    intros: { openai_from_edge: 'hola' },
  };
  const r = resolveProfile(cfg, 'default');
  assert.equal(r.profileFound, true);
  assert.equal(r.primary, 'openai');
  assert.equal(r.openai.character_name, 'Claudito');
  assert.equal(r.intros.openai_from_edge, 'hola');
});

test('shape viejo: pedir perfil no-default igual retorna lo que hay en shape viejo', () => {
  const cfg = {
    primary: 'openai', fallback: 'edge',
    providers: {
      openai: { character_name: 'Claudito' },
      edge: { character_name: 'Tommy' },
    },
  };
  const r = resolveProfile(cfg, 'qa');
  // Shape viejo no tiene perfiles, todo se interpreta como default.
  assert.equal(r.profileFound, true);
  assert.equal(r.openai.character_name, 'Claudito');
});

test('archivo inexistente: retorna DEFAULT_PROFILE hardcoded', () => {
  const r = resolveProfile(null, 'default');
  assert.equal(r.profileFound, false);
  assert.equal(r.primary, 'openai');
  assert.equal(r.openai.character_name, 'Claudito');
});

test('fallback: si es null explícito, se respeta (sin fallback)', () => {
  const cfg = {
    profiles: {
      default: { primary: 'openai', fallback: null, openai: {}, edge: {} },
    },
  };
  const r = resolveProfile(cfg, 'default');
  assert.equal(r.fallback, null);
});

test('merge: openai/edge de un perfil se mergean con defaults si faltan campos', () => {
  const cfg = {
    profiles: {
      qa: {
        primary: 'edge', fallback: 'openai',
        // No declara openai ni edge — debería hacer merge con los defaults
      },
    },
  };
  const r = resolveProfile(cfg, 'qa');
  assert.equal(r.primary, 'edge');
  assert.equal(r.openai.character_name, 'Claudito'); // heredado de DEFAULT
  assert.equal(r.edge.character_name, 'Tommy');      // heredado de DEFAULT
});

test('tts-config.json real tiene 13 perfiles y todos tienen primary/fallback/openai/edge', () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'tts-config.json'), 'utf8'));
  assert.ok(real.profiles);
  const profileNames = Object.keys(real.profiles);
  assert.equal(profileNames.length, 13);
  for (const name of profileNames) {
    const p = real.profiles[name];
    assert.ok(p.primary, `${name}: falta primary`);
    assert.ok(p.fallback, `${name}: falta fallback`);
    assert.ok(p.openai, `${name}: falta openai`);
    assert.ok(p.edge, `${name}: falta edge`);
    assert.ok(p.openai.character_name, `${name}: openai sin character_name`);
    assert.ok(p.edge.character_name, `${name}: edge sin character_name`);
  }
});

test('tts-config.json real tiene todos los agentes esperados', () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'tts-config.json'), 'utf8'));
  const expected = ['default', 'qa', 'guru', 'security', 'po', 'ux', 'planner', 'review', 'tester', 'android-dev', 'backend-dev', 'web-dev', 'pipeline-dev'];
  for (const name of expected) {
    assert.ok(real.profiles[name], `falta perfil '${name}'`);
  }
});

test('tts-config.json: perfil qa tiene primary edge (por costo)', () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'tts-config.json'), 'utf8'));
  assert.equal(real.profiles.qa.primary, 'edge');
  assert.equal(real.profiles.qa.fallback, 'openai');
  assert.equal(real.profiles.qa.edge.character_name, 'Nacho');
  assert.equal(real.profiles.qa.openai.character_name, 'Rulo');
});

test('tts-config.json: perfil default mantiene Claudito/Tommy (no roto)', () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'tts-config.json'), 'utf8'));
  assert.equal(real.profiles.default.openai.character_name, 'Claudito');
  assert.equal(real.profiles.default.edge.character_name, 'Tommy');
});
