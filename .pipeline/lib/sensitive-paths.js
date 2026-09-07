#!/usr/bin/env node
// =============================================================================
// sensitive-paths.js — Issue #5463 (split de #5451, épico #5428)
//
// **Inventario cerrado de paths sensibles del repositorio.** Fuente única de
// verdad compartida por las tres capas de contención:
//
//   1. `.gitignore`                       — evita que el archivo entre al índice.
//   2. `.husky/pre-commit` (scanner)      — segunda capa: bloquea el commit aunque
//                                           alguien des-ignore el path.
//   3. `.pipeline/lib/__tests__/credential-path-guards.test.js` — verifica ambas
//                                           capas contra ESTE inventario.
//
// Antes de #5463 cada capa tenía su propia lista hardcodeada y divergían: el
// scanner cubría tres paths de estado del commander (#3310) mientras que
// `.gitignore` cubría otros; `.pipeline/credentials.json` y
// `.pipeline/telegram-config.json` — los dos stores de credenciales que el
// inventario del spike #5216 marca como "dentro del repo" — no estaban en
// ninguna de las dos. Cualquier alta futura se hace ACÁ y las tres capas la
// heredan.
//
// Invariantes que sostiene el test:
//   - Toda entrada con `requiereIgnore: true` da `rc=0` en
//     `git check-ignore -v --no-index <muestra>` con una regla NO negada.
//   - Ninguna de esas muestras está trackeada (`git ls-files`).
//   - Toda entrada del inventario es reconocida por `clasificarPath()`, que es
//     lo que consume el scanner de pre-commit.
//   - `.env.example` sigue permitido (excepción explícita).
//
// Sobre la evidencia: este módulo declara PATHS y REGLAS, nunca contenido. Los
// tests y el scanner tampoco imprimen contenido de archivos sensibles — sólo el
// path y la regla de `.gitignore` que lo cubre.
// =============================================================================
'use strict';

/**
 * Clases del inventario:
 *   - `credencial`  → almacena material de autenticación (tokens, API keys, OAuth).
 *   - `cripto`      → material criptográfico (claves privadas, keystores).
 *   - `estado`      → estado runtime del pipeline que puede arrastrar secretos en
 *                     su contenido (mensajes de Telegram, respuestas de providers).
 *
 * Campos:
 *   - `reglas`          → strings que DEBEN existir como línea de `.gitignore`.
 *   - `muestras`        → paths concretos con los que se verifica `check-ignore`.
 *   - `pathspecs`       → pathspecs para `git ls-files` (verificación de no-trackeo).
 *   - `requiereIgnore`  → si `.gitignore` debe cubrirlo. `false` SÓLO para paths
 *                         hoy trackeados legítimamente, donde un ignore taparía
 *                         un archivo versionado: ahí la contención es el escaneo
 *                         de contenido. Cada caso lleva su comentario y el issue
 *                         que se ocupa del destrackeo (`servicios-state`,
 *                         `claude-hooks-telegram-config` → #5226).
 *   - `escaneaContenido`→ si el scanner de pre-commit debe pasarlo por el sanitizer.
 *   - `test(rel)`       → matcher explícito sobre el path relativo al root del repo
 *                         (con `/` como separador). Explícito a propósito: nada de
 *                         glob casero, que es donde estas guardas fallan callado.
 */
const SENSITIVE_PATHS = Object.freeze([
    {
        id: 'env-dotfiles',
        clase: 'credencial',
        reglas: ['.env', '.env.*'],
        muestras: ['.env', '.env.produccion'],
        pathspecs: ['.env', ':(glob).env.*', ':(glob)**/.env'],
        requiereIgnore: true,
        escaneaContenido: true,
        motivo: 'Variables de entorno con credenciales de backend/QA. `.env.example` es la única excepción.',
        test: (p) => {
            const base = basename(p);
            if (base === '.env.example') return false;
            return base === '.env' || base.startsWith('.env.');
        },
    },
    {
        id: 'secrets-json',
        clase: 'credencial',
        reglas: ['secrets.json', '**/secrets.json'],
        muestras: ['secrets.json', '.pipeline/secrets.json'],
        pathspecs: [':(glob)**/secrets.json'],
        requiereIgnore: true,
        escaneaContenido: true,
        motivo: 'Nombre canónico de volcado de secretos. Nunca se versiona, en ningún nivel del árbol.',
        test: (p) => basename(p) === 'secrets.json',
    },
    {
        id: 'claude-secrets-store',
        clase: 'credencial',
        reglas: ['.claude/secrets/', '**/.claude/secrets/'],
        muestras: ['.claude/secrets/credentials.json'],
        pathspecs: [':(glob)**/.claude/secrets/**'],
        requiereIgnore: true,
        escaneaContenido: true,
        motivo: 'Store canónico de credenciales (~/.claude/secrets/). Si aparece dentro del repo es una copia indebida.',
        test: (p) => p === '.claude/secrets' || p.startsWith('.claude/secrets/') || p.includes('/.claude/secrets/'),
    },
    {
        id: 'claude-oauth-credentials',
        clase: 'credencial',
        reglas: ['.claude/.credentials.json', '**/.claude/.credentials.json'],
        muestras: ['.claude/.credentials.json'],
        pathspecs: [':(glob)**/.claude/.credentials.json'],
        requiereIgnore: true,
        escaneaContenido: true,
        motivo: 'Sesión OAuth de Claude Code (token de acceso vivo del plan Max).',
        test: (p) => p === '.claude/.credentials.json' || p.endsWith('/.claude/.credentials.json'),
    },
    {
        id: 'pipeline-credentials',
        clase: 'credencial',
        reglas: ['.pipeline/credentials.json'],
        muestras: ['.pipeline/credentials.json'],
        pathspecs: ['.pipeline/credentials.json'],
        requiereIgnore: true,
        escaneaContenido: true,
        motivo: 'Copia dentro del repo del store de credenciales del pipeline (API keys de providers). Alta explícita de #5451.',
        test: (p) => p === '.pipeline/credentials.json',
    },
    {
        id: 'pipeline-telegram-config',
        clase: 'credencial',
        reglas: ['.pipeline/telegram-config.json'],
        muestras: ['.pipeline/telegram-config.json'],
        pathspecs: ['.pipeline/telegram-config.json'],
        requiereIgnore: true,
        escaneaContenido: true,
        motivo: 'Config de Telegram del pipeline: bot_token + chat_id. Alta explícita de #5451.',
        test: (p) => p === '.pipeline/telegram-config.json',
    },
    {
        id: 'qa-telegram-config',
        clase: 'credencial',
        reglas: ['qa/scripts/telegram-config.json'],
        muestras: ['qa/scripts/telegram-config.json'],
        pathspecs: ['qa/scripts/telegram-config.json'],
        requiereIgnore: true,
        escaneaContenido: true,
        motivo: 'Config de Telegram del runner de QA (SEC-3, #4173).',
        test: (p) => p === 'qa/scripts/telegram-config.json',
    },
    {
        id: 'claude-hooks-telegram-config',
        clase: 'credencial',
        // Sin `reglas` / `requiereIgnore: false`: este archivo ESTÁ TRACKEADO hoy
        // y los hooks de Telegram lo leen del repo, así que un ignore acá taparía
        // un archivo versionado (mismo antipatrón que evita `servicios-state`).
        // El destrackeo + la regla de ignore son responsabilidad de #5226; hasta
        // que eso ocurra la contención de esta entrada es el escaneo de contenido
        // del pre-commit, que es justamente la capa que faltaba.
        //
        // Por qué entra igual al inventario: es portador de credenciales
        // (`bot_token`, `chat_id`, `openai_api_key`) y es el ÚNICO path del repo
        // donde el re-commit de una credencial ya ocurrió — 11 commits del
        // historial llevan un `bot_token` de formato real. El propio archivo lo
        // documenta en `_secrets_note` ("NO restaurar credenciales aquí - quedan
        // trackeadas en git") y #5226 registró que su working copy llegó a tener
        // valores reales de Google OAuth. Dejarlo fuera del inventario hacía que
        // `isSensitive()` devolviera null y que NINGUNA de las dos capas mirara
        // el archivo: restaurar el token real + `git add` pasaba limpio.
        reglas: [],
        muestras: ['.claude/hooks/telegram-config.json'],
        pathspecs: [],
        requiereIgnore: false,
        escaneaContenido: true,
        motivo: 'Config de Telegram de los hooks de Claude Code: bot_token + chat_id + openai_api_key. Trackeado a la espera del destrackeo de #5226; cobertura por contenido, no por ignore (ver comentario).',
        test: (p) => p === '.claude/hooks/telegram-config.json' || p.endsWith('/.claude/hooks/telegram-config.json'),
    },
    {
        id: 'api-keys-backup',
        clase: 'credencial',
        reglas: ['.intrale-api-keys.json', '**/.intrale-api-keys.json'],
        muestras: ['.intrale-api-keys.json'],
        pathspecs: [':(glob)**/.intrale-api-keys.json'],
        requiereIgnore: true,
        escaneaContenido: true,
        motivo: 'Respaldo ad-hoc de API keys detectado por el spike #5216 (cuarto almacén, no declarado en el épico).',
        test: (p) => basename(p) === '.intrale-api-keys.json',
    },
    {
        id: 'aws-credentials',
        clase: 'credencial',
        reglas: ['.aws/credentials', '**/.aws/credentials'],
        muestras: ['.aws/credentials'],
        pathspecs: [':(glob)**/.aws/credentials'],
        requiereIgnore: true,
        escaneaContenido: true,
        motivo: 'Perfiles del AWS CLI (access key + secret). El vault no reemplaza ~/.aws, pero una copia en el repo es fuga directa.',
        test: (p) => p === '.aws/credentials' || p.endsWith('/.aws/credentials'),
    },
    {
        id: 'service-account',
        clase: 'credencial',
        reglas: ['**/service-account*.json'],
        muestras: ['service-account.json', 'qa/scripts/service-account-drive.json'],
        pathspecs: [':(glob)**/service-account*.json'],
        requiereIgnore: true,
        escaneaContenido: true,
        motivo: 'Service accounts de Google (clave privada embebida en el JSON).',
        test: (p) => /^service-account.*\.json$/.test(basename(p)),
    },
    {
        id: 'google-app-config',
        clase: 'credencial',
        reglas: ['**/google-services.json', '**/GoogleService-Info.plist'],
        muestras: ['app/composeApp/google-services.json', 'app/iosApp/GoogleService-Info.plist'],
        pathspecs: [':(glob)**/google-services.json', ':(glob)**/GoogleService-Info.plist'],
        requiereIgnore: true,
        escaneaContenido: true,
        motivo: 'Configs de Firebase/Google con API keys de la app. Hoy no existen (verificado por #5216); la regla es preventiva.',
        test: (p) => basename(p) === 'google-services.json' || basename(p) === 'GoogleService-Info.plist',
    },
    {
        id: 'npmrc',
        clase: 'credencial',
        reglas: ['.npmrc', '**/.npmrc'],
        muestras: ['.npmrc'],
        pathspecs: [':(glob)**/.npmrc'],
        requiereIgnore: true,
        escaneaContenido: true,
        motivo: 'Config de npm: suele traer `_authToken` del registry. El repo no versiona ninguno.',
        test: (p) => basename(p) === '.npmrc',
    },
    {
        id: 'claves-privadas',
        clase: 'cripto',
        reglas: ['*.pem', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.ppk', 'id_rsa', 'id_rsa.*', 'id_ed25519', 'id_ed25519.*'],
        muestras: [
            'muestra-guardas-5463.pem',
            'muestra-guardas-5463.p12',
            'muestra-guardas-5463.pfx',
            'muestra-guardas-5463.jks',
            'muestra-guardas-5463.keystore',
            'muestra-guardas-5463.ppk',
            'id_rsa',
            'id_ed25519',
        ],
        pathspecs: [
            ':(glob)**/*.pem', ':(glob)**/*.p12', ':(glob)**/*.pfx',
            ':(glob)**/*.jks', ':(glob)**/*.keystore', ':(glob)**/*.ppk',
            ':(glob)**/id_rsa', ':(glob)**/id_rsa.*',
            ':(glob)**/id_ed25519', ':(glob)**/id_ed25519.*',
        ],
        requiereIgnore: true,
        escaneaContenido: true,
        motivo: 'Material criptográfico (claves privadas, keystores de firma). Contención pedida por #5451.',
        test: (p) => {
            const base = basename(p);
            if (/\.(pem|p12|pfx|jks|keystore|ppk)$/i.test(base)) return true;
            return /^id_(rsa|ed25519)(\..*)?$/.test(base);
        },
    },
    {
        id: 'pipeline-runtime-state',
        clase: 'estado',
        reglas: ['.pipeline/state/'],
        muestras: ['.pipeline/state/probe.json'],
        pathspecs: [':(glob).pipeline/state/**'],
        requiereIgnore: true,
        escaneaContenido: true,
        motivo: 'Estado runtime del pipeline. Todo descendiente debe permanecer fuera del índice y de los pull requests (#6111).',
        test: (p) => p.startsWith('.pipeline/state/') && p.length > '.pipeline/state/'.length,
    },
    {
        id: 'commander-session',
        clase: 'estado',
        reglas: ['.pipeline/commander-session.json'],
        muestras: ['.pipeline/commander-session.json'],
        pathspecs: ['.pipeline/commander-session.json'],
        requiereIgnore: true,
        escaneaContenido: true,
        motivo: 'Sesión viva del Commander: transcripción de Telegram, puede arrastrar secretos pegados por el operador (#3310).',
        test: (p) => p === '.pipeline/commander-session.json',
    },
    {
        id: 'commander-history',
        clase: 'estado',
        reglas: ['.pipeline/commander-history.jsonl'],
        muestras: ['.pipeline/commander-history.jsonl'],
        pathspecs: ['.pipeline/commander-history.jsonl'],
        requiereIgnore: true,
        escaneaContenido: true,
        motivo: 'Historial append-only del Commander, mismo riesgo que la sesión (#3310).',
        test: (p) => p === '.pipeline/commander-history.jsonl',
    },
    {
        id: 'servicios-state',
        clase: 'estado',
        // Sin `reglas`: NO exige cobertura de `.gitignore`. `.pipeline/servicios/`
        // mezcla estado efímero (ya ignorado por fase: `pendiente/`, `trabajando/`,
        // `listo/`, `procesado/`) con artefactos trackeados legítimos
        // (`condenser-fired-*.json`). Un ignore amplio acá dejaría archivos
        // versionados tapados por una regla — peor que no tenerla. El destrackeo
        // de lo que sobra es de #5226; hasta entonces la contención de esta
        // entrada es el escaneo de contenido del pre-commit, heredado de #3310.
        reglas: [],
        // Las muestras sólo se usan para verificar el matcher y la cobertura del
        // scanner: al ser `requiereIgnore: false`, el test no les corre check-ignore.
        muestras: ['.pipeline/servicios/github/estado-runtime.json'],
        pathspecs: [],
        requiereIgnore: false,
        escaneaContenido: true,
        motivo: 'Estado de los servicios del pipeline (respuestas de providers, mensajes). Cobertura por contenido, no por ignore (ver comentario).',
        test: (p) => p.startsWith('.pipeline/servicios/') && p.endsWith('.json'),
    },
    {
        id: 'pipeline-credential-reminder-state',
        clase: 'estado',
        reglas: ['.pipeline/credential-reminder-state.json'],
        muestras: ['.pipeline/credential-reminder-state.json'],
        pathspecs: ['.pipeline/credential-reminder-state.json'],
        requiereIgnore: true,
        escaneaContenido: true,
        // #5901 · REQ-SEC-1. El archivo estuvo TRACKEADO en un repo PÚBLICO
        // (contenido `{}`, historial benigno: no hace falta reescribir historia).
        // El estado ahora vive en `~/.claude/pipeline-state/`, fuera del árbol.
        // Esta regla es lo que impide que vuelva a entrar por un `git add .`:
        // sin ella el destrackeo se revierte solo en el próximo commit amplio.
        // Lo que publicaba no es el VALOR de ningún secreto sino el mapa:
        // qué variables usa Intrale, de qué proyecto es cada una y qué día
        // vence cada una. Reconocimiento dirigido, gratis y sin dejar rastro.
        motivo: 'Estado del cron de rotación: nombres de variables de secretos, su proyecto y su calendario de vencimiento. El repo es público.',
        test: (p) => p === '.pipeline/credential-reminder-state.json',
    },
]);

/**
 * Excepciones explícitas: paths que matchean una regla del inventario pero que
 * DEBEN seguir versionados. Se verifican en el test para que ningún endurecimiento
 * futuro los tape por accidente.
 */
const EXCEPCIONES = Object.freeze([
    {
        path: '.env.example',
        regla: '!.env.example',
        motivo: 'Plantilla sin valores reales; es la documentación de qué variables hay que definir.',
    },
]);

function basename(p) {
    const norm = String(p || '').replace(/\\/g, '/');
    const i = norm.lastIndexOf('/');
    return i === -1 ? norm : norm.slice(i + 1);
}

/** Normaliza a path relativo con `/`, sin `./` inicial. */
function normalizar(rel) {
    return String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Clasifica un path relativo al root del repo contra el inventario.
 * @returns {{id: string, clase: string, requiereIgnore: boolean, escaneaContenido: boolean, motivo: string}|null}
 */
function clasificarPath(rel) {
    const p = normalizar(rel);
    if (!p) return null;
    for (const entrada of SENSITIVE_PATHS) {
        let hit = false;
        try {
            hit = entrada.test(p);
        } catch (_e) {
            // Un matcher que tira no puede volver permisivo el inventario: se
            // ignora esa entrada y siguen las demás (las otras capas cubren).
            hit = false;
        }
        if (hit) {
            return {
                id: entrada.id,
                clase: entrada.clase,
                requiereIgnore: entrada.requiereIgnore,
                escaneaContenido: entrada.escaneaContenido,
                motivo: entrada.motivo,
            };
        }
    }
    return null;
}

/** true si el path está declarado como excepción versionable. */
function esExcepcion(rel) {
    const p = normalizar(rel);
    return EXCEPCIONES.some((e) => e.path === p || p.endsWith('/' + e.path));
}

/** Todas las reglas que `.gitignore` tiene que contener, aplanadas y deduplicadas. */
function reglasRequeridas() {
    const out = [];
    for (const e of SENSITIVE_PATHS) {
        if (!e.requiereIgnore) continue;
        for (const r of e.reglas) if (!out.includes(r)) out.push(r);
    }
    return out;
}

module.exports = {
    SENSITIVE_PATHS,
    EXCEPCIONES,
    clasificarPath,
    esExcepcion,
    reglasRequeridas,
    __forTestsOnly__: { basename, normalizar },
};
