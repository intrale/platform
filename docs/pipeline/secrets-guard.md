# Guard de origen de credenciales (`secrets-guard`)

> TRAMO 3 del split de #5218 · implementado en #5245 · su activación en `strict` es #5263.

El repo es **público**. Cualquier credencial que se lea —o se escriba— desde un archivo que
vive adentro del árbol del repo termina publicada. `.pipeline/lib/secrets-guard.js` hace esa
condición **detectable primero** e **imposible después**.

## API

```js
const { classifyOrigin, assertSecretOrigin } = require('.pipeline/lib/secrets-guard');

classifyOrigin(filePath, { op })      // 'outside' | 'in_repo' | 'undetermined' — nunca lanza
assertSecretOrigin(filePath, {        // fail-closed
    op: 'read' | 'write',
    secret: 'telegram.bot_token',     // OBLIGATORIO: dot-path de .pipeline/secrets-manifest.json
    site: 'telegram-client.getConfig' // opcional, alimenta `instrumented_sites`
});
```

### Por qué `secret` es obligatorio

`.claude/hooks/telegram-config.json` es un archivo **dual**: tiene claves operativas versionadas
con consumidores vivos (`quiet_hours`, `safe_directories`, `severity_timeouts`…) y claves de
secreto (`bot_token`, `openai_api_key`). Si el guard clasificara por **archivo**, cada lectura de
`quiet_hours` sumaría un `in_repo_read`, el contador no bajaría nunca, y el arreglo bajo presión
sería una allowlist a nivel archivo que reabre el agujero completo.

El dot-path se valida contra el **manifiesto de #5242**, no contra una lista hardcodeada que se
desincroniza. Una clave que no está en el manifiesto **no es un secreto**: pasa y no cuenta.

### Fail-closed

- Origen fuera del repo → pasa.
- Origen adentro de **cualquier** worktree (`git worktree list --porcelain`) → rechaza.
- Symlink hacia adentro, casing distinto en NTFS, archivo gitignored → rechazan igual.
- Origen **indeterminado** (error de fs, `git` no resuelve) → **rechaza**. Un guard que ante la
  duda deja pasar no es fail-closed. El mensaje de `undetermined` es **distinto** al de `in_repo`:
  si los dos dijeran lo mismo, el diagnóstico del próximo incidente sería adivinanza.
- `op: 'write'` resuelve el `realpath` del **ancestro existente más cercano**: una hoja
  inexistente fuera del repo es el caso normal de crear el store canónico en una máquina limpia,
  no un origen indeterminado.

## Modos

| Modo | Cómo se activa | Qué hace |
|---|---|---|
| `warn` (**default**) | `PIPELINE_SECRETS_GUARD_STRICT` sin definir | loguea **una línea** con prefijo `[secrets-guard] WARN`, cuenta, y **no** tira |
| `strict` | `PIPELINE_SECRETS_GUARD_STRICT=1` | lanza `SecretOriginError` (`code` = `SECRET_ORIGIN_IN_REPO` \| `SECRET_ORIGIN_UNDETERMINED`) |

Precedente de control reusado: `PIPELINE_PERMISSION_VALIDATOR_STRICT` (`pulpo.js`), comparación
estricta contra `'1'`.

Contar warns del rollout:

```bash
grep -c "\[secrets-guard\] WARN" .pipeline/logs/secrets-guard.log
grep -v "\[secrets-guard\] WARN" .pipeline/logs/pulpo.log   # filtrarlos
```

## Condición de corte (la ejecuta #5263)

Los contadores viven en `.pipeline/secrets-health.json` (gitignored) bajo `migration`, **todos
números, ningún array de paths**:

```json
{
  "in_repo_reads": 0,
  "distinct_sources": 0,
  "instrumented_sites": 2,
  "undetermined_origins": 0,
  "uninstrumented_readers": 49
}
```

**Corte = `in_repo_reads === 0` AND `uninstrumented_readers === 0`.**

`uninstrumented_readers` es el **denominador** y lo calcula `.pipeline/lib/secrets-census.js` en
runtime, nunca hardcodeado: cuenta los archivos de código trackeados que leen
`telegram-config.json` con `readFileSync` sin pasar por el chokepoint. Sin denominador, el
numerador puede marcar cero con decenas de lectores intactos — y ese cero es lo único que
autorizaría a encender `strict`.

> El número se movió solo mientras la historia estuvo bloqueada: 46 (2026‑07‑30) → 50
> (2026‑08‑14) → 49 (tras instrumentar `telegram-client.js`). Por eso se mide, no se escribe.

### Procedimiento de medición

```bash
# 1. poner el numerador en cero y estampar ts_reset
node -e "require('./.pipeline/lib/secrets-guard').resetHealthCounters()"

# 2. refrescar el denominador
node .pipeline/lib/secrets-census.js --write

# 3. dejar correr el pipeline y volver a mirar
node -e "console.log(require('./.pipeline/secrets-health.json').migration)"
```

Los contadores son **acumulados entre resets**: cada proceso suma lo suyo al salir. Bajan a cero
sólo con `resetHealthCounters()`, así que `in_repo_reads === 0` significa "ningún proceso leyó un
secreto in-repo desde el reset".

`uninstrumented_readers` vale `-1` mientras no se haya medido: es un número, no es cero, y por lo
tanto no habilita el corte por accidente.

## Redacción de la salida (CA-7d)

El camino `motivo:` → YAML → GitHub → Telegram termina en un repo público. Toda la salida del
guard pasa por `.pipeline/lib/redact.js`: ni el valor, ni un prefijo, ni la longitud, ni un hash.

Los **paths** se redactan con los patrones de valor pero **sin** la heurística de entropía: un
path absoluto de más de 40 caracteres la dispara y el mensaje pierde exactamente el dato que lo
hace accionable. Además, si el archivo vive adentro del repo se muestra **relativo al root**.

## Allowlist de fixtures

Exige **las dos** condiciones a la vez: segmento `__tests__`/`fixtures` en el path **Y** corrida
de test (`NODE_TEST_CONTEXT`, `NODE_ENV=test` o `PIPELINE_SECRETS_GUARD_TEST=1`). Una allowlist es
un bypass del control y tiene su **test negativo** obligatorio.

## Sitios instrumentados (al mergear #5245)

| Sitio | Qué declara |
|---|---|
| `.pipeline/lib/telegram-secrets.js` (fallback legacy) | el secreto se está resolviendo desde el archivo in-repo |
| `.claude/hooks/telegram-client.js#getConfig` | el archivo in-repo leído para config operativa **también trae material de secreto** |

Los consumidores de claves puramente operativas (`permission-utils.js`, `notify-telegram.js`,
`permission-gate.js`, `cost-report.js`, `qa-video-share.js`) **no** se instrumentan: leen el
archivo in-repo legítimamente.
