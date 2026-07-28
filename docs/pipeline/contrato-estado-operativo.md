# Contrato del envoltorio de estado operativo

**Módulo:** `.pipeline/lib/operational-state.js`
**Issue:** #5108 (Ola 9.4 · E2, parte de #5107)
**Estado:** entregado — sin consumidores migrados todavía (la migración es #5109)

---

## 1. Para qué existe

El estado operativo del pipeline —el registro de olas y la allowlist que gatea el
dispatch— se toca hoy desde ~193 lugares, y **cada uno conoce la ruta física del
archivo** que lee o escribe.

| Estado | Archivos que lo tocan directo (medición 2026-07-28 sobre `main`) |
|---|---|
| Registro de olas | 33 |
| Allowlist de ejecución | 160 |

Mientras siga así, mover ese estado a otro lado es inviable: habría que reescribir
cada punto de acceso, con riesgo de dejar la mitad leyendo el archivo viejo y la
otra mitad el destino nuevo — dos fuentes de verdad, el peor escenario posible.

Este módulo es **la única puerta de entrada**. No cambia dónde vive el dato ni el
formato de los archivos: compone la superficie ya existente de `waves.js` y
`partial-pause.js`, que ya tienen lock, escritura atómica y validación estricta.

Base documental de la ola: `docs/pipeline/externalizacion-estado-operativo-remoto.md`
§4 (modelo de acceso CQRS-lite) y §7 (inventario de componentes a modificar).

---

## 2. Invariante central: ningún consumidor conoce la ruta física

> Un consumidor debe poder **leer y mutar** tanto el registro de olas como la
> allowlist efectiva sin nombrar jamás un path.

Consecuencias vinculantes:

- La fachada **no re-exporta `_paths()`**. La única forma de alcanzar rutas es
  `_internal.paths()`, que existe **exclusivamente para los tests** (montar
  fixtures, limpiar caché). Un consumidor productivo que use `_internal` está
  violando el contrato.
- El criterio de "listo" del invariante no es "existe un módulo": es que un
  consumidor pueda hacer su trabajo completo sin literales de path. Por eso la
  superficie cubre **los dos archivos desde el día 1**. Cubrir sólo el registro
  de olas dejaría el invariante a medias — el literal del marker de allowlist
  está hardcodeado en 29 archivos, contra 8 del registro de olas.
- Guarda automática: el pre-checklist de la historia corre
  `grep -rn "partial-pause.json\|waves.json" .pipeline/lib/operational-state.js`
  y debe dar vacío.

---

## 3. Dos conceptos de "allowlist" — no son lo mismo

La ambigüedad entre estos dos es la causa histórica de que el invariante se
cumpliera a medias. Acá tienen **nombres distintos y deliberadamente disjuntos**:

| Concepto | Qué es | Escribible | ¿Gatea el dispatch? | Superficie en la fachada |
|---|---|---|---|---|
| **Alcance de la ola** | Proyección derivada de los issues de la ola activa, filtrando los `completed`. | No — se deriva | **No** | `getWaveScopeIssues()` |
| **Allowlist efectiva** | El estado que realmente decide si el Pulpo puede tomar un issue. | Sí, con autorización | **Sí** | `getDispatchState()`, `isIssueAllowed()`, mutadores |

`getAllowlist` **no se re-exporta con ese nombre**: sería el mismo alias ambiguo
que hoy hace que los consumidores confundan una cosa con la otra. Hay un test que
verifica que `opState.getAllowlist === undefined`.

Estar en alcance de la ola **no habilita el dispatch por sí solo**.

---

## 4. Semántica de dispatch preservada (#5060)

La fachada **no cambia ninguno de los tres modos vigentes**:

| Modo | Cuándo | `isIssueAllowed(n)` | `isSkillAllowed(s)` |
|---|---|---|---|
| `paused` | halt total explícito (marker propio, gana sobre todo) | `false` | `false` |
| `partial_pause` | hay allowlist efectiva | `n ∈ allowlist` | `s ∈ allowedSkills` |
| `running` | sin ningún marker de control | **`false`** (fail-closed) | `true` |

### Por qué `running` deniega

El 2026-07-26 (#5060), al cerrarse una ola la poda convergente vació la
allowlist, el marker se borró, el modo cayó a `running`, y `isIssueAllowed()`
devolvía `true` para cualquier issue: el Pulpo perdió su único freno y dispatchó
~320 agentes sobre ~100 issues del backlog histórico, que generaron 97 issues
nuevos.

**El disparador no es hipotético: es el fin de ola normal.** Por eso "sin
allowlist" significa **denegar**, no **permitir**. El estado natural del pipeline
es estar acotado a la ola vigente.

El escape hatch `PIPELINE_ALLOW_UNSCOPED_DISPATCH=1` es la **única** vía de
dispatch sin ola. Está apagado por default, loguea un warning por proceso, y
sólo acepta el valor exacto `'1'`. Jamás debe quedar prendido en operación
normal.

Hay dos tests de contrato (`CONTRATO #5060: …`) que fallan si la fachada
reintroduce el fail-open. Son la red de seguridad de esta regresión.

### Por qué los skills NO heredan el fail-closed

`isSkillAllowed` permite en `running` a propósito. El gate de issues acota el
**backlog** a la ola vigente; los skills son componentes del control-plane
(smoke-test de providers, harnesses de diagnóstico) que no consumen backlog.
Denegarlos dejaría al pipeline sin diagnóstico justo cuando no hay ola activa.

---

## 5. Autorización obligatoria en mutadores de allowlist (#3625)

El gate de autorización de `partial-pause.js` corre en **grace mode por default**
(sólo es estricto con `PARTIAL_PAUSE_STRICT_AUTH=1`), o sea que un caller sin
`authorizedBy` **pasaría en silencio con un warning**.

Por eso la fachada exige `authorizedBy` **y** `justification` en la propia firma
de todos sus mutadores de allowlist. Llamarlos sin ellos (o con strings vacíos /
sólo espacios) tira `OperationalStateError` con `code: 'EOPSTATE_UNAUTHORIZED'`
**antes de tocar nada**.

Ambos valores se propagan **sin default y sin reescritura**. La fachada
deliberadamente **no inventa un `authorizedBy` genérico propio**: colapsaría la
trazabilidad de ~29 callers en una sola identidad y volvería inútil el audit
trail. Cada caller declara el suyo, del enum cerrado de
`partial-pause-audit.AUTHORIZED_BY_STATIC`.

Precedente correcto ya en el repo: `waves-api.js` declara su propio
`ALLOWLIST_AUTHORIZED_BY` y lo pasa explícito.

---

## 6. Superficie pública

### Olas · lectura

Todas parten de **un** snapshot estricto (`waves.loadStateStrict()`), que valida
shape e integridad. Las proyecciones se derivan de ese mismo snapshot: nunca de
dos lecturas distintas.

| Función | Devuelve |
|---|---|
| `getActiveWave()` | ola activa o `null` |
| `getPlannedWave(n)` | ola planificada por número o `null` |
| `listWaves()` | activa → planificadas → archivadas, con `status` explícito |
| `getHorizon(N = 5)` | activa + N planificadas |
| `getBlockingIssues(n)` | issues que bloquean a `n` |
| `getVersion()` | token de versión del estado actual (ETag) |
| `versionToken(state)` | token de un snapshot ya leído (función pura) |

`getVersion()` / `versionToken()` habilitan las escrituras condicionales que
consume #5113: se devuelven tal cual al mutador en `meta.expectedVersion`.

### Olas · mutación

`addIssueToWave`, `removeIssueFromWave`, `markIssuesCompletedInActiveWave`,
`addDependency`, `createPlannedWave`, `editWave`, `deletePlannedWave`,
`reorderPlannedWaves`, `promoteWave`, `archiveWave`.

`promoteWave(n, metadata)` usa por default la variante **transaccional** (marker
+ recovery de boot, coordina registro y allowlist). Con `{ atomic: false }` cae a
la variante que sólo toca el registro.

### Alcance de ola (derivado, sólo lectura)

`getWaveScopeIssues()`.

### Allowlist efectiva · lectura

`getDispatchState()`, `isIssueAllowed(n)`, `isIssueAllowedInState(n, state)`,
`isSkillAllowed(s)`, `isSkillAllowedInState(s, state)`,
`unscopedDispatchEnabled()`, `readFullPauseOrigin()`.

Las variantes `*InState` existen para callers que iteran muchos issues en un
mismo tick (counters de cola, reconciler) y no quieren releer el filesystem por
cada uno.

### Allowlist efectiva · mutación (`authorizedBy` + `justification` obligatorios)

`setAllowlist`, `setAllowlistAtomic`, `addToAllowlist`, `removeFromAllowlist`,
`clearAllowlist`, `resumeAll`, `setFullPause`, `clearFullPause`.

#### Reemplazo vs. incremental — qué preserva cada uno

El marker de allowlist no es sólo una lista de issues: lleva además el **gate de
skills** (`allowed_skills`, #3680), la procedencia de cada issue (`dep_sources`,
`accepted_dep_risk`, #2893), la metadata de la ola (`wave_number` / `wave_name`,
#4030) y el `source` del audit trail (#3625). Y `setPartialPause()` reescribe el
marker **desde cero** en cada write.

| Mutador | Semántica |
|---|---|
| `setAllowlist` / `setAllowlistAtomic` | **Reemplazo.** Lo que el caller no declara en `opts`, no se conserva. Es la semántica deliberada de un setter. |
| `addToAllowlist` / `removeFromAllowlist` | **Incremental.** Read-modify-write del marker **completo** bajo lock: mergean el eje `allowed_issues` y re-propagan todos los demás campos. El caller pisa sólo lo que declara explícitamente. |

> El RMW lee el marker **crudo**, no `getPipelineMode()`: ese último no devuelve
> `wave_number`/`wave_name`/`wave_goal`, y con `.paused` presente devuelve el
> estado `paused` con listas vacías — usarlo como fuente borraría los skills en
> cada mutación hecha durante un halt total.

**Por qué esto es de autorización y no de prolijidad.** Un RMW parcial (que lea
sólo `allowed_issues`) no pierde metadata: **ensancha permisos**. Al perderse
`allowed_skills` se apaga la ventana de skills; y si la remoción vacía los
issues, el marker se borra, el modo cae a `running` y — como el gate de skills
**no** es fail-closed en `running` (§4) — quedan permitidos **todos** los skills,
`delivery` (el que mergea a `main`) incluido. El caller pidió quitar un issue y
terminaría levantando una restricción que nunca pidió levantar.

#### `removeFromAllowlist` no borra el gate por efecto colateral

Si la remoción vaciaría `allowed_issues`:

- **con `allowed_skills` activos** → se conserva la ventana de skills: el marker
  queda con `allowed_issues: []` y el modo sigue en `partial_pause` (dispatch de
  issues denegado por #5060, gate de skills intacto).
- **sin skills** → se **rechaza**: devuelve `{ ok: false, rejected: true, reason:
  'would-clear-allowlist' }` y no escribe nada. Vaciar la allowlist se pide con
  `clearAllowlist()`, que es explícito y audita como `clear`; el caller que
  quiera el clear desde el propio `remove` lo declara con `allowClear: true`.

Simétricamente, `addToAllowlist` nunca borra el marker: si no hay nada válido
que agregar es un no-op (`{ ok: true, noop: true }`), no un clear disfrazado.

### Errores

`OperationalStateError` (base) y `OperationalStateValidationError` (extiende la
anterior), con `code`, `stage`, `field` y `errors`.

---

## 7. Lo que la fachada **no** expone, y por qué

| No exportado | Razón |
|---|---|
| `save(snapshot)` | Rompería el read-modify-write. El caller leería el snapshot **fuera** del lock, mutaría en memoria, y el segundo escritor pisaría al primero: archivo válido pero **actualización perdida**. La escritura son funciones de mutación, cada una delegando en la variante `*Locked` ya existente. |
| `loadWaves()` | Lectura cruda y tolerante. La fachada sólo ofrece lecturas validadas. |
| `getAllowlist()` | Alias ambiguo entre los dos conceptos de §3. |
| `_paths()` | Invariante de §2. |

Hay un test que verifica que estos tres primeros son `undefined`.

---

## 8. Nivel de garantía por sub-superficie

**Las garantías no son uniformes.** Una superficie uniforme comunica una garantía
uniforme que no existe, así que se declara explícito:

| Sub-superficie | Escritura atómica | Validación de shape en lectura | Hash de integridad | Read-modify-write bajo lock |
|---|---|---|---|---|
| **Registro de olas** — lectura | n/a | ✅ estricta, fail-closed con campo inválido | ✅ verificado en cada lectura estricta | n/a |
| **Registro de olas** — mutación | ✅ tmp + fsync + rename | ✅ | ✅ sellado en cada write | ✅ (lock reentrante, caché invalidada antes de leer) |
| **Allowlist efectiva** — lectura | n/a | ⚠️ parcial (parseo + normalización, sin schema estricto) | ❌ **ninguno** | n/a |
| **Allowlist efectiva** — mutación | ✅ tmp + rename bajo lock | ⚠️ parcial | ❌ **ninguno** | ✅ para `addToAllowlist` / `removeFromAllowlist`, sobre el marker **completo** (§6) |

### La asimetría importa

El archivo que **no** tiene protección de integridad es justamente **el que gatea
el dispatch**. Un `waves.json` alterado fuera del flujo normal se detecta y
frena el pipeline (`EWAVES_INTEGRITY` → human-block); una allowlist alterada
fuera del flujo normal **no se detecta**.

Emparejar la protección es **#5116**, fuera de alcance de esta historia. Nota de
alcance para cuando se haga: el hash actual del registro de olas es SHA-256 **sin
clave** — detecta corrupción y escritura fuera del módulo, **no resiste a un
adversario con permiso de escritura**.

### Semántica de `setAllowlist([])`

Con listas de issues **y** de skills vacías, `setAllowlist` equivale a
`clearAllowlist()`: borra el marker y el modo cae a `running`, que **deniega**.
Es la semántica vigente de `setPartialPause` y se preserva sin cambios. **No es
"habilitar todo"** — leer §4 antes de asumir lo contrario.

---

## 9. Dirección de dependencia (invariante anti-ciclo)

```
operational-state.js ──requiere──▶ waves.js
                     ──requiere──▶ partial-pause.js
        ▲
        └── consumidores (migración en #5109)
```

`partial-pause.js` ya requiere `waves.js` en top-level, y `waves.js` requiere
`partial-pause.js` de forma **diferida dentro de la función** justamente para
esquivar el ciclo. La fachada respeta esa dirección y **compone hacia abajo**.

Está **prohibido** agregar `require('./operational-state')` en `waves.js`,
`partial-pause.js`, `partial-pause-audit.js` o `file-lock.js`. Hay un test
(`ningún módulo base requiere operational-state`) que hace grep estático y falla
si alguien invierte la dirección.

---

## 10. Cómo se verifica

```bash
npm run test:pipeline                    # suite completa del pipeline
node --test .pipeline/lib/__tests__/operational-state.test.js
node --test .pipeline/lib/__tests__/operational-state-concurrency.test.js
```

- `operational-state.test.js` — superficie, invariante de no-path, atomicidad,
  fail-closed con campo inválido, los tres modos, contrato #5060, gate #3625,
  separación de los dos conceptos de allowlist, guarda anti-ciclo, y la
  **preservación del marker completo** en los mutadores incrementales (§6):
  `add` conserva skills / `dep_sources` / metadata de ola / `source` — también
  bajo halt total —, `remove` hasta vaciar no ensancha el gate de skills, y el
  clear de la allowlist sólo ocurre si se pide explícito.
- `operational-state-concurrency.test.js` — dos (y N=8) escritores en **procesos
  reales** vía `fork`. No in-process: `waves.js` cachea lecturas 2s por proceso,
  así que dos llamadas dentro del mismo proceso pasarían en verde aunque hubiera
  lost update.

---

## 11. Alcance y reversibilidad

- **No** se migró ningún consumidor. Eso es **#5109**.
- **No** se modificó ni deprecó la superficie de `waves.js` / `partial-pause.js`.
  La fachada **suma**; los ~30 consumidores vivos siguen funcionando igual.
- **No** se cambió el formato ni la ubicación de los archivos.
- **R8 (revertible en minutos):** borrar `operational-state.js`, sus dos tests, el
  fixture del worker y este documento. Nada más depende de ellos.
