'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadIntoEnv,
  ENV_MAPPING,
  LEGACY_MAPPING,
  isPlaceholderOrEmpty,
} = require('../credentials');

// Set total de env vars que el cargador toca. Snapshot para no contaminar
// otros tests que corran en el mismo proceso.
const ALL_ENV_VARS = [...new Set([
  ...Object.values(ENV_MAPPING),
  ...Object.values(LEGACY_MAPPING),
])];

function withCleanEnv(fn) {
  const snapshot = {};
  for (const v of ALL_ENV_VARS) {
    snapshot[v] = process.env[v];
    delete process.env[v];
  }
  try { return fn(); }
  finally {
    for (const v of ALL_ENV_VARS) {
      if (snapshot[v] === undefined) delete process.env[v];
      else process.env[v] = snapshot[v];
    }
  }
}

function withTmpFiles(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credentials-test-'));
  const canonical = path.join(dir, 'credentials.json');
  const legacy = path.join(dir, 'telegram-config.json');
  try { return fn({ dir, canonical, legacy }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

// ─── canonical: happy path ──────────────────────────────────────────────────

test('loadIntoEnv hidrata todas las vars desde credentials.json canonical', () => {
  withCleanEnv(() => {
    withTmpFiles(({ canonical, legacy }) => {
      writeJson(canonical, {
        telegram: { bot_token: '12345:botoken-test', chat_id: '99999' },
        providers: {
          openai:   { api_key: 'sk-proj-openai-test' },
          google:   { api_key: 'AIza-gemini-test' },
          cerebras: { api_key: 'csk-cerebras-test' },
          nvidia:   { api_key: 'nvapi-nvidia-test' },
        },
        multimedia: {
          elevenlabs_api_key:  'eleven-key-test',
          elevenlabs_voice_id: 'voice-id-test',
        },
      });

      const env = {};
      const result = loadIntoEnv({ canonicalPath: canonical, legacyPath: legacy, env, logger: () => {} });

      assert.equal(result.source, 'canonical');
      assert.equal(env.TELEGRAM_BOT_TOKEN, '12345:botoken-test');
      assert.equal(env.TELEGRAM_CHAT_ID, '99999');
      assert.equal(env.OPENAI_API_KEY, 'sk-proj-openai-test');
      assert.equal(env.GEMINI_API_KEY, 'AIza-gemini-test');
      assert.equal(env.CEREBRAS_API_KEY, 'csk-cerebras-test');
      assert.equal(env.NVIDIA_NIM_API_KEY, 'nvapi-nvidia-test');
      assert.equal(env.ELEVENLABS_API_KEY, 'eleven-key-test');
      assert.equal(env.ELEVENLABS_VOICE_ID, 'voice-id-test');
      // #3353 — GROQ_API_KEY removida tras descontinuación; ya no se hidrata.
      assert.equal(env.GROQ_API_KEY, undefined);
      assert.ok(result.hydrated.includes('CEREBRAS_API_KEY'));
      assert.deepEqual(result.skipped_existing, []);
    });
  });
});

// ─── precedencia env > JSON ─────────────────────────────────────────────────

test('NO sobrescribe env vars que ya estan seteadas (precedencia env > JSON)', () => {
  withCleanEnv(() => {
    withTmpFiles(({ canonical, legacy }) => {
      writeJson(canonical, {
        providers: { cerebras: { api_key: 'csk-from-json' } },
      });
      const env = { CEREBRAS_API_KEY: 'csk-already-set-from-env' };
      const result = loadIntoEnv({ canonicalPath: canonical, legacyPath: legacy, env, logger: () => {} });

      assert.equal(env.CEREBRAS_API_KEY, 'csk-already-set-from-env');
      assert.ok(result.skipped_existing.includes('CEREBRAS_API_KEY'));
      assert.ok(!result.hydrated.includes('CEREBRAS_API_KEY'));
    });
  });
});

// ─── placeholders y empty ───────────────────────────────────────────────────

test('skipea placeholders conocidos (REVOKED, PLACEHOLDER, MOVED, ...)', () => {
  withCleanEnv(() => {
    withTmpFiles(({ canonical, legacy }) => {
      writeJson(canonical, {
        telegram: { bot_token: 'MOVED_TO_HOME', chat_id: '' },
        providers: {
          openai:   { api_key: 'CHANGE_ME' },
          cerebras: { api_key: 'csk-real-value' },
        },
      });
      const env = {};
      const result = loadIntoEnv({ canonicalPath: canonical, legacyPath: legacy, env, logger: () => {} });

      assert.equal(env.CEREBRAS_API_KEY, 'csk-real-value');
      assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
      assert.equal(env.TELEGRAM_CHAT_ID, undefined);
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.ok(result.skipped_empty.includes('TELEGRAM_BOT_TOKEN'));
      assert.ok(result.skipped_empty.includes('OPENAI_API_KEY'));
    });
  });
});

test('isPlaceholderOrEmpty cubre null/undefined/empty/whitespace/placeholder', () => {
  assert.equal(isPlaceholderOrEmpty(null), true);
  assert.equal(isPlaceholderOrEmpty(undefined), true);
  assert.equal(isPlaceholderOrEmpty(''), true);
  assert.equal(isPlaceholderOrEmpty('   '), true);
  assert.equal(isPlaceholderOrEmpty('PLACEHOLDER'), true);
  assert.equal(isPlaceholderOrEmpty('REVOKED'), true);
  assert.equal(isPlaceholderOrEmpty('MOVED_TO_HOME'), true);
  assert.equal(isPlaceholderOrEmpty('change_me'), true);
  assert.equal(isPlaceholderOrEmpty('sk-proj-real-key-123'), false);
  assert.equal(isPlaceholderOrEmpty('gsk_real'), false);
});

// ─── fallback al legacy ─────────────────────────────────────────────────────

test('cuando canonical no existe, hace fallback al legacy con flat keys', () => {
  withCleanEnv(() => {
    withTmpFiles(({ canonical, legacy }) => {
      // canonical NO existe
      writeJson(legacy, {
        bot_token: '12345:legacy-token',
        chat_id: '88888',
        anthropic_api_key: 'sk-ant-legacy',
        openai_api_key: 'sk-proj-legacy',
      });
      const env = {};
      const warnings = [];
      const result = loadIntoEnv({
        canonicalPath: canonical,
        legacyPath: legacy,
        env,
        logger: (m) => warnings.push(m),
      });

      assert.equal(result.source, 'legacy');
      assert.equal(env.TELEGRAM_BOT_TOKEN, '12345:legacy-token');
      assert.equal(env.TELEGRAM_CHAT_ID, '88888');
      assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-legacy');
      assert.equal(env.OPENAI_API_KEY, 'sk-proj-legacy');
      // #3353 — GROQ_API_KEY removida del legacy mapping junto con el provider.
      assert.equal(env.GROQ_API_KEY, undefined);
      assert.ok(warnings.some((m) => /legacy/i.test(m)),
        'debe emitir warning indicando que usa legacy');
    });
  });
});

test('legacy NO carga providers nuevos (google/cerebras/nvidia se acaban si solo hay legacy)', () => {
  withCleanEnv(() => {
    withTmpFiles(({ canonical, legacy }) => {
      writeJson(legacy, {
        bot_token: '12345:t',
        chat_id: '1',
        // legacy NO conoce el field "google_api_key" ni "cerebras_api_key"
      });
      const env = {};
      const result = loadIntoEnv({ canonicalPath: canonical, legacyPath: legacy, env, logger: () => {} });

      assert.equal(result.source, 'legacy');
      assert.equal(env.GEMINI_API_KEY, undefined);
      assert.equal(env.CEREBRAS_API_KEY, undefined);
      assert.equal(env.NVIDIA_NIM_API_KEY, undefined);
    });
  });
});

// ─── archivo corrupto ───────────────────────────────────────────────────────

test('canonical corrupto cae al legacy con warning', () => {
  withCleanEnv(() => {
    withTmpFiles(({ canonical, legacy }) => {
      fs.writeFileSync(canonical, '{ this is not valid json', 'utf8');
      writeJson(legacy, { anthropic_api_key: 'sk-ant-from-legacy-after-corrupt' });

      const env = {};
      const warnings = [];
      const result = loadIntoEnv({
        canonicalPath: canonical,
        legacyPath: legacy,
        env,
        logger: (m) => warnings.push(m),
      });

      assert.equal(result.source, 'legacy');
      assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-from-legacy-after-corrupt');
      assert.ok(warnings.some((m) => /invalido/i.test(m)));
    });
  });
});

test('si ambos archivos faltan, source=none y NO lanza', () => {
  withCleanEnv(() => {
    withTmpFiles(({ canonical, legacy }) => {
      const env = {};
      const warnings = [];
      const result = loadIntoEnv({
        canonicalPath: canonical,
        legacyPath: legacy,
        env,
        logger: (m) => warnings.push(m),
      });

      assert.equal(result.source, 'none');
      assert.equal(result.hydrated.length, 0);
      assert.ok(warnings.some((m) => /no se encontro/i.test(m)));
    });
  });
});

// ─── chat_id numerico ───────────────────────────────────────────────────────

test('chat_id numerico se convierte a string', () => {
  withCleanEnv(() => {
    withTmpFiles(({ canonical, legacy }) => {
      writeJson(canonical, {
        telegram: { bot_token: 'tok', chat_id: 12345 },
      });
      const env = {};
      loadIntoEnv({ canonicalPath: canonical, legacyPath: legacy, env, logger: () => {} });

      assert.equal(env.TELEGRAM_CHAT_ID, '12345');
      assert.equal(typeof env.TELEGRAM_CHAT_ID, 'string');
    });
  });
});

// ─── mapping coverage ───────────────────────────────────────────────────────

test('ENV_MAPPING cubre los providers IA vivos + telegram + multimedia', () => {
  const values = new Set(Object.values(ENV_MAPPING));
  assert.ok(values.has('TELEGRAM_BOT_TOKEN'));
  assert.ok(values.has('TELEGRAM_CHAT_ID'));
  assert.ok(values.has('OPENAI_API_KEY'));
  assert.ok(values.has('ANTHROPIC_API_KEY'));
  assert.ok(values.has('GEMINI_API_KEY'));
  assert.ok(values.has('CEREBRAS_API_KEY'));
  assert.ok(values.has('NVIDIA_NIM_API_KEY'));
  assert.ok(values.has('ELEVENLABS_API_KEY'));
  assert.ok(values.has('ELEVENLABS_VOICE_ID'));
  // #3353 — GROQ_API_KEY removida tras la descontinuación del provider.
  assert.ok(!values.has('GROQ_API_KEY'), 'GROQ_API_KEY debería estar removida tras #3353');
});
