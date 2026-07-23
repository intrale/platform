# Capturador de cuota Anthropic — operación y supervisión

Documentación operativa del **capturador de cuota** (OCR de Claude Desktop) del
pipeline V2. Cubre el scheduler (`.pipeline/quota-snapshot-scheduler.js`), el
script de captura (`.pipeline/scripts/capture-quota-snapshot.ps1`), la
persistencia (`.pipeline/lib/quota-snapshot-persist.js`) y la **supervisión**
vía Windows Task Scheduler (issue #4326, split de #4324).

> Este split produce el **dato** (snapshot Anthropic por OCR + persistencia en
> disco). El **render** en la HOME / `/api/state` es la hija hermana de #4324 y
> queda fuera de scope.

---

## 1. Qué hace y cómo fluye

El scheduler orquesta, por tick, el pipeline `capture → parse → persist`:

1. **Kill-switch** — si `QUOTA_SNAPSHOT_ENABLED=false` (o `0`/`no`) → skip
   silencioso (`isEnabled`, decisión de operador a nivel entorno, sin hardcodear).
2. **Capture** — spawnea `capture-quota-snapshot.ps1`, que lanza Claude Desktop
   offscreen y captura un PNG de la ventana.
3. **Parse** — `lib/quota-snapshot-parser.js` hace OCR y valida el
   `account_handle` contra `EXPECTED_CLAUDE_ACCOUNT` (**fail-closed**).
4. **Persist** — `lib/quota-snapshot-persist.js` `appendSnapshot` appendea la
   entrada a `.pipeline/.quota-history.jsonl` (append-only, con `mkdir -p`).
5. **Rotación + retención** de JSONL y PNGs.

`.quota-history.jsonl` **sólo se crea cuando `runOnce` llega a `ok`**. Si no
existe hoy, es porque el flujo nunca llegó a `ok` (causa ambiental, ver §4), no
un bug de `appendSnapshot`.

### Ejecución

- Servicio persistente: `node .pipeline/quota-snapshot-scheduler.js` (loop con
  tick cada `QUOTA_SNAPSHOT_INTERVAL_MIN` min, default 60).
- Tick único (lo que usa la tarea supervisada): `node .pipeline/quota-snapshot-scheduler.js --once`.

---

## 2. Variables de entorno (dependencia ambiental — Riesgo #2)

El "dato fresco" real depende de **3 env vars coordinadas con el operador**. El
código no las puede garantizar; hay que resolverlas a nivel máquina/usuario
**antes** de esperar corridas exitosas.

| Env var | Efecto | Default |
|---|---|---|
| `QUOTA_SNAPSHOT_ENABLED` | `false`/`0`/`no` → kill-switch (skip). Cualquier otro valor → habilitado. | habilitado |
| `CLAUDE_DESKTOP_PATH` | Path absoluto al `.exe` de Claude Desktop (binario **pinned**, validado con `Test-Path -LiteralPath`). | (requerido) |
| `EXPECTED_CLAUDE_ACCOUNT` | Handle de cuenta esperado; el parser compara contra el OCR (**fail-closed**). | (requerido) |
| `QUOTA_SNAPSHOT_INTERVAL_MIN` | Intervalo del loop persistente (min 5, max 1440). | 60 |
| `QUOTA_SNAPSHOT_PS1_PATH` | Override del path al `.ps1`. | script por defecto |

Además, Claude Desktop debe estar **logueado en la cuenta esperada** y poder
**renderizar offscreen** en el host. Eso es operador-side.

---

## 3. Supervisión (CA-2) — Windows Task Scheduler (Opción B)

**Recomendación del arquitecto:** supervisar vía Task Scheduler, NO acoplar al
`launchAll()` de `restart.js`. Motivo (Riesgo #1): la captura depende de una
condición ambiental que puede fallar legítimamente (Claude Desktop no
renderiza); un fallo así **no debe disparar el auto-rollback** del pipeline
residente (que mueve el tag `pipeline-stable`). Task Scheduler **desacopla** la
captura del gate de smoke-test/rollback.

### Registrar la tarea

```powershell
powershell -NonInteractive -File .pipeline\scripts\register-quota-snapshot-task.ps1
# intervalo custom:
powershell -NonInteractive -File .pipeline\scripts\register-quota-snapshot-task.ps1 -IntervalMinutes 30
```

Registra la tarea `Intrale-Pipeline-V2-QuotaSnapshot` que corre
`node quota-snapshot-scheduler.js --once` cada N min (default 60), con:

- **Principal**: usuario interactivo que corre el script, RunLevel **Limited**
  (SIN `-Principal`, NO SYSTEM, NO Highest — SEC-4, el script vive en ruta
  escribible por los agentes).
- **Acción**: `node.exe` con argumentos como **array** (Task Scheduler no
  interpola shell — sin env envenenada interpolada, SEC-4). `node.exe` se
  **pinnea** con su ruta absoluta al momento del registro (Task Scheduler no
  hereda el PATH del shell).
- **ExecutionTimeLimit** 5 min: una instancia colgada nunca bloquea (hard-cap
  interno de captura: 90s).

### Verificar / desregistrar

```powershell
powershell -NonInteractive -File .pipeline\scripts\register-quota-snapshot-task.ps1 -Verify
powershell -NonInteractive -File .pipeline\scripts\register-quota-snapshot-task.ps1 -Unregister
```

### Evidencia de CA-2

Corrida periódica **supervisada** (no manual). Sirven, en conjunto:

- `-Verify` mostrando `State`, `LastRunTime`, `LastTaskResult`, `NextRunTime`.
- `logs/quota-snapshot.log` con **≥2 timestamps espaciados** que evidencien
  ticks automáticos (no output de suite de tests).

---

## 4. Diagnóstico de fallos del capturador (CA-3)

`capture-quota-snapshot.ps1` loguea, ante fallo, una línea

```
DIAG exit=<n> causa=<foco|path|render> razon=<detalle>
```

que distingue la condición exacta:

| exit | causa | Significado | Resolución |
|---|---|---|---|
| 2 | `foco` | El operador está usando Claude Desktop. Skip idempotente. | Ninguna (esperado). |
| 4 | `path` | `CLAUDE_DESKTOP_PATH` no seteado o binario pinned inexistente. | Setear/corregir la env var. |
| 5 | `render` | La ventana no renderizó offscreen dentro del timeout (sesión desconectada / login pendiente). | Loguear Claude Desktop en la cuenta esperada. |

**SEC-2 (sin PII):** el diagnóstico loguea sólo paths de filesystem y estados de
render. **Nunca** vuelca `account_handle` (real ni esperado) ni contenido OCR.

### `account_mismatch` (fail-closed — SEC-1, NO relajar)

Si el OCR lee una cuenta distinta de `EXPECTED_CLAUDE_ACCOUNT`, el parser
(`lib/quota-snapshot-parser.js`) devuelve `account_mismatch` **sin filtrar** el
handle real ni el esperado. Es el invariante de seguridad #3 del issue:
**prohibido relajar la validación** para "destrabar" el flujo. Causa típica:
`EXPECTED_CLAUDE_ACCOUNT` vacío/mal seteado, cuenta equivocada logueada, u OCR
misread. Se resuelve **en el entorno**, no en el código.

---

## 5. Invariantes de seguridad a preservar

| Invariante | Dónde | Regla |
|---|---|---|
| **SEC-1** fail-closed cuenta | `parser.js:376-381` | No relajar la validación `EXPECTED_CLAUDE_ACCOUNT`. |
| **SEC-2** logs sin PII | `capture-quota-snapshot.ps1` | Diagnóstico path-vs-render-vs-foco, nunca `account_handle`/OCR. |
| **SEC-3** artefactos fuera de git | `.gitignore:211-214` | `.quota-history.jsonl` y `quota-snapshots/*.png` siempre gitignored. |
| **SEC-4** spawn seguro | `register-quota-snapshot-task.ps1`, `.ps1:257-261` | Sin interpolación de shell; binario pinned validado; principal Limited. |

Verificación rápida de SEC-3:

```bash
git check-ignore .pipeline/.quota-history.jsonl .pipeline/quota-snapshots/dummy.png
```

---

## 6. Tests

```bash
node --test .pipeline/__tests__/quota-snapshot-scheduler.test.js
```

Cubre, entre otros: `runOnce` happy-path escribe snapshot vía `appendSnapshot`;
kill-switch `QUOTA_SNAPSHOT_ENABLED=false` sigue haciendo `skip`; mapeo de exit
codes del `.ps1` a categorías del alerter.
