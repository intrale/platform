# waves-schema — Modelo de planificación multi-ola (#3616)

Documento operativo del schema 1.0 de `waves.json` y `.partial-pause.json`,
del modelo de confianza, y del flujo Opción A que conecta planificación
canónica con operación real del pipeline V3.

> **Cobertura**: docs/pipeline/modelo-planificacion-multi-ola.md define el
> *qué* y el *por qué* de las olas; este documento es el *cómo* a nivel
> archivo + flujo + recuperación.

---

## TL;DR

- `waves.json` es la **fuente de verdad canónica** de toda la planificación
  (activa, planificadas, archivadas, dependencias).
- `.partial-pause.json` es un **espejo operacional derivado**: lo lee el
  pulpo en el intake para saber qué issues procesar.
- `/wave promote N+X` actualiza ambos archivos atómicamente (waves.json →
  .partial-pause.json). Nunca editar `.partial-pause.json` a mano.
- El **boot del pulpo** corre `init-waves-from-partial.js` antes del
  desync-detector para sembrar `waves.json` si está vacío (idempotente,
  fail-closed).
- Si quedan inconsistentes → `desync-detector` alerta Telegram + pone el
  pipeline en `human-block`. **No auto-repara**.

---

## Diagrama del flujo (Opción A)

```
                    +--------------------+
                    |   /wave promote N  |
                    | (Telegram + CLI)   |
                    +---------+----------+
                              |
                              v
            +-----------------+-----------------+
            |   promoteWaveAtomic (lib/waves)   |
            |  1. snapshot bak + marker fsync   |
            |  2. write waves.json (active=N)   |
            |  3. write .partial-pause.json     |
            |     (mismos issues de la ola N)   |
            |  4. commit marker → unlink        |
            +-----------------+-----------------+
                              |
            +-----------------+-----------------+
            |                                   |
            v                                   v
    +-------+-------+                  +--------+--------+
    |  waves.json   |                  | .partial-pause  |
    |  (canónica)   |                  |   (espejo del   |
    |  active+plan+ |                  |   intake)       |
    |  archived     |                  +--------+--------+
    +-------+-------+                           |
            |                                   v
            |                          +--------+--------+
            |                          |  pulpo intake   |
            |                          |  isIssueAllowed |
            |                          +--------+--------+
            |                                   |
            v                                   v
       +----+-----+                        +----+-----+
       | dashboard |                        | dispatch |
       | "Próximas |                        | a skills |
       |  Olas"    |                        +----------+
       +-----------+
```

Lectura del diagrama:
- `waves.json` es la fuente de verdad; el resto del sistema deriva de ahí.
- El pulpo **no lee `waves.json` directamente** para decidir intake. Lee
  `.partial-pause.json` (más barato, más simple). El espejo se mantiene
  sincronizado vía `/wave promote`.
- El dashboard sí lee `waves.json` (vía `getHorizon(5)`) para mostrar el
  panel "Próximas Olas".

---

## Schema 1.0 de `waves.json`

```jsonc
{
  "version": "1.0",
  "meta": {
    "created_at": "2026-05-24T00:00:00Z",
    "updated_at": "2026-05-29T13:00:00Z",
    "updated_by": "init-waves-from-partial",   // o Commander, planner, etc.
    "source": "auto-seed",                     // o "telegram", "manual", "planner"
    "note": "Seed inicial desde .partial-pause.json (#3616). 9 issue(s) sembrados."
  },
  "active_wave": {                             // null si no hay ola activa
    "number": 1,
    "name": "Ola seed #1",
    "goal": "Estabilizar el pipeline post-3518",
    "started_at": "2026-05-29T13:00:00Z",
    "issues": [
      { "number": 3559, "status": "in_progress" },
      { "number": 3616, "status": "in_progress" },
      { "number": 3638, "status": "in_progress" }
    ]
  },
  "planned_waves": [                           // array (vacío si no hay)
    {
      "number": 2,
      "name": "Ola N+2 — Multi-provider",
      "goal": "Bajar costo Anthropic 30%",
      "issues": [
        { "number": 3700, "notes": "blocker: depende de #3616" }
      ]
    }
  ],
  "archived_waves": [                          // array (vacío si no hay)
    {
      "number": 0,
      "name": "Ola N — Foundations",
      "closed_at": "2026-04-19T00:00:00Z",
      "issues_completed": 12,
      "issues_failed": 1,
      "actual_duration_days": 5
    }
  ],
  "dependencies": [                            // grafo de bloqueos
    { "blocker": 3559, "blocked": 3700, "reason": "API contract" }
  ],
  "integrity_hash": "3f1a…64hex"               // #4370 — SHA-256 canónico (ver abajo)
}
```

### Glosario de campos

| Campo | Tipo | Notas |
|---|---|---|
| `version` | string | Siempre `"1.0"`. Bump rompe contracts (PRs grandes). |
| `meta.created_at` | ISO 8601 | Inmutable post-creación. |
| `meta.updated_at` | ISO 8601 | Toca en cada save. |
| `meta.updated_by` | string | Quién/qué hizo el último write (audit trail). |
| `meta.source` | string | `manual` / `telegram` / `commander` / `planner` / `auto-seed` / `wave-promote-atomic`. |
| `meta.note` | string | Descripción humana del cambio. |
| `active_wave` | object\|null | La ola en curso. `null` cuando no hay nada activo. |
| `active_wave.number` | int positivo | Identificador único de la ola. |
| `active_wave.name` | string | Nombre legible (ej. "Ola N+5 — Dashboard"). |
| `active_wave.goal` | string | Objetivo de negocio. |
| `active_wave.started_at` | ISO 8601 | Cuándo se promovió a activa. |
| `active_wave.issues[].number` | int positivo | Issue de GitHub. |
| `active_wave.issues[].status` | enum | `in_progress` \| `completed` \| `failed` \| `blocked`. |
| `planned_waves[]` | array | Olas futuras planificadas (orden = prioridad). |
| `archived_waves[]` | array | Olas cerradas con métricas. |
| `archived_waves[].issues_completed` | int | Cuántos issues terminaron OK. |
| `archived_waves[].issues_failed` | int | Cuántos fallaron o quedaron bloqueados. |
| `archived_waves[].actual_duration_days` | int | Días reales. |
| `dependencies[]` | array | Grafo bloqueador → bloqueado. |
| `integrity_hash` | string (hex 64) | #4370 — SHA-256 canónico del estado (omite el propio campo). Sellado en cada save; verificado al boot/load. Opcional en legacy (se sella en el primer save). |

### Validación

`lib/waves.validateStateStrict(state)` aplica antes de cada write. Si devuelve
errores, el write se rechaza con `EWAVES_SCHEMA` + alerta Telegram. **Cero
escritura de basura**.

Desde **#4370** la validación estricta cubre además (defensa ante estados
hostiles que disparan trabajo automático del pipeline):

- **`issue.number` como entero positivo** en `active_wave`, `planned_waves[]` y
  `archived_waves[]` (no strings arbitrarios — el número construye trabajo real).
- **Tipos string** de los campos libres (`name`, `goal`, `note`, `updated_by`,
  `source`, `status`, `notes`). `null` se tolera como "ausente". Estos campos
  fluyen a sinks (dashboard = XSS almacenado, Telegram = markdown injection); el
  tipo estricto en el schema + el escape en el punto de render (`esc()` en el
  dashboard, `escapeMarkdownV2`/`fill-template` en Telegram) son las dos capas.
- **Límites anti-OOM**: `MAX_WAVES_PER_BUCKET=500`, `MAX_ISSUES_PER_WAVE=2000`,
  `MAX_FREE_STRING_LEN=20000`, `MAX_STATE_BYTES=5MB`. Un `waves.json` inflado por
  un atacante se rechaza antes de recorrerse en el load de arranque.

La variante permisiva `loadWaves()` se mantiene intacta para los consumers
legacy (dashboard, commander-deterministic, planner-waves, wave-resolver,
eta-wave, canonical-facts, wizards): la strictness sólo aplica en los caminos de
**escritura / restore / boot**.

### Hash de integridad — `integrity_hash` (#4370)

`waves.json` persiste un campo top-level `integrity_hash`: el **SHA-256 del
estado canónico** (claves ordenadas recursivamente) **omitiendo el propio campo**
para evitar recursión. Se computa y sella en cada `saveStateLocked` dentro del
write atómico existente.

```jsonc
{
  "version": "1.0",
  "meta": { /* ... */ },
  "active_wave": { /* ... */ },
  "planned_waves": [],
  "archived_waves": [],
  "dependencies": [],
  "integrity_hash": "3f1a…64hex"   // SHA-256 canónico, sellado en cada save
}
```

- **Verificación al boot** (`waves.checkStateIntegrity()`, llamado por `pulpo.js`):
  distingue *corrupción silenciosa* / *tampering schema-válido* de un estado
  sano. `ok` → log; `mismatch` → log WARN + alerta Telegram (human-block blando:
  el pipeline sigue con el estado actual hasta revisión humana, no se autodestruye);
  `missing` → estado legacy (ver migración); `schema_invalid`/`unreadable` → log.
- **Verificación en `loadStateStrict()`**: `mismatch` tira `EWAVES_INTEGRITY` +
  alerta (fail-closed para los caminos que exigen estado íntegro).
- **Migración tolerante (CA-9)**: un `waves.json` **legacy sin `integrity_hash`**
  se carga OK (`missing`, no falla) y queda **sellado en el primer save**. No se
  bumpea `SCHEMA_VERSION` porque el shape sólo agrega un campo opcional
  retrocompatible.

### Retención / rotación de backups en `archived/` (#4370)

`saveStateLocked` deja un backup timestamped `waves.<ts>.json` antes de
sobreescribir, y `snapshotForTransaction` deja `waves-rollback.<ts>.json` /
`partial-pause-rollback.<ts>.json` por transacción de `/wave promote`. Sin cota,
`archived/` crecía sin fin (baseline previo: 29 backups) → DoS por disco, parse
lento en restart y exposición indefinida de secretos.

`waves.rotateArchivedBackups(keep = WAVES_ARCHIVED_KEEP || 20)`:

- Conserva los **N más recientes por familia** (por `mtime`) y **borra el resto,
  logueando cada descarte** (`[rotación] descartado backup … — excede retención`).
- **No toca** backups referenciados por un `wave-promote.in-progress.json` vivo
  (evita romper un restore en curso). Si el marker está presente pero ilegible,
  es conservador y **no rota nada**.
- Corre best-effort al final de cada save (nunca bloquea el write).
- **Redacción defensiva**: `meta.note` / `meta.source` pasan por
  `redact.redactSecretValue` antes de persistir — un secreto pegado desde
  Telegram no queda en texto plano en `waves.json` ni en sus backups. Texto
  normal ("add issue #123 → wave 5") queda intacto.

---

## Schema de `.partial-pause.json`

```jsonc
{
  "allowed_issues": [3559, 3616, 3638],       // array<int positivo> obligatorio
  "created_at": "2026-05-29T13:00:00Z",
  "source": "wave-promote-atomic",            // quién escribió
  "accepted_dep_risk": true,                  // opcional (#2893)
  "dep_sources": { "3616": "auto-deps" }      // opcional (#2893)
}
```

- Compatible con consumidores legacy del intake (`partialPause.isIssueAllowed`).
- Lo escribe **exclusivamente** `partial-pause.setPartialPauseAtomic`,
  invocado desde `waves.promoteWaveAtomic` o desde el Commander para pausar
  con allowlist explícito.
- **Nunca editar a mano**. Si necesitás cambiar el set: `/wave add #N`
  + `/wave promote`, o re-promover la misma ola.

---

## Modelo de confianza

Estos dos archivos son **fuente de verdad operacional del pipeline V3**.
Las garantías que ofrecen dependen de que NUNCA sean escritos por fuera de
la API de `lib/waves.js` y `lib/partial-pause.js`.

> **Regla operativa**: cualquier escritura no atómica fuera de la API puede
> dejar el sistema en `human-block`. El desync-detector está diseñado
> precisamente para detectar y bloquear cuando aparece inconsistencia.

### Lo que **sí podés** hacer

- Leer ambos archivos a mano (con `cat`, `jq`, etc.) — son JSON estable.
- Usar `/wave promote`, `/wave add`, `/wave status`, `/wave next` desde
  Telegram o como CLI.
- Restaurar manualmente desde `archived/waves.*.json` si hay corrupción,
  copiando el snapshot deseado al lugar de `waves.json` mientras el pulpo
  está parado.

### Lo que **NO debés** hacer

- Editar `.partial-pause.json` con un editor de texto en caliente.
- Editar `waves.json` saltando la API (no toleramos last-write-wins).
- Disparar `setPartialPause` y `saveState(active_wave=...)` por separado
  para "fingir" un promote — eso es exactamente lo que evita
  `promoteWaveAtomic`.

---

## Recuperación ante desync

Si el pulpo encuentra `waves.json` y `.partial-pause.json` apuntando a
allowlists distintos al boot:

1. `desync-detector.detectDesync()` crea `.pipeline/.desync-detected.flag`.
2. Telegram alerta con paths + diff added/removed.
3. El pipeline entra en `human-block` (no procesa intake).
4. **Acción manual**:
   - `cat .pipeline/.desync-detected.flag | jq .` para ver el diff exacto.
   - Decidir cuál archivo refleja la realidad operativa.
   - Restaurar manualmente o, si querés re-sembrar desde
     `.partial-pause.json`, podés correr `node .pipeline/scripts/init-waves-from-partial.js`
     con `waves.json` vacío (idempotente: si waves.json tiene active_wave,
     NO toca; si está corrupto, aborta).
   - Borrar `.desync-detected.flag` cuando esté resuelto.
5. Confirmar con `/wave status` y, si querés, reiniciar el pulpo
   (`node .pipeline/restart.js`).

Si la inconsistencia vino de un crash mid-promote, el boot ya lo recupera
solo con `recoverIncompletePromote()` (#3520) — restaura desde snapshot y
loggea WARN.

---

## `/wave repair` (futuro)

A día de hoy la recuperación es manual (paso 4 de arriba). El issue **#3618**
trackea la creación de un comando `/wave repair` que automatice el
diagnóstico y proponga acciones (sin auto-aplicar — siempre con
confirmación humana).

---

## Referencias cruzadas

- `docs/pipeline/modelo-planificacion-multi-ola.md` — modelo conceptual.
- `lib/waves.js` — implementación de la canónica.
- `lib/partial-pause.js` — implementación del espejo operacional.
- `lib/desync-detector.js` — detector de inconsistencia.
- `.pipeline/scripts/init-waves-from-partial.js` — seed inicial (#3616).
- `.pipeline/WAVES_CHEATSHEET.md` — cheat sheet operativa de los comandos.
- Issues: #3487 (widget dashboard), #3488 (planner), #3489 (lib/waves),
  #3492 (ETA por ola), #3493 (comandos Telegram), #3518 (atomic writes +
  desync detector), #3520 (rollback transaccional), **#3616 (init + sin
  fallback)**.
