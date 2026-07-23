# Wiring de fases del pipeline para consumir el contrato de tarea (Ola Puente · H3 · #4719)

> **Historia:** #4719 — Wiring de fases del pipeline para consumir el contrato de tarea · size:L
> **Parent:** #4716 (Abstracción de tareas genéricas) · **Épico:** #4644 (Ola Puente — Kernel multi-producto)
> **Depende de:** #4717 (H1 · contrato de tarea) y #4718 (H2 · ejecutor `provisioner_infra`).
> **Naturaleza:** **implementación de wiring** (no rediseño). Hace que las fases
> **actuales** lean el contrato de tarea en vez de asumir que el entregable es
> código. **No agrega ni quita fases** (no big-bang).
>
> **Documentos hermanos:**
> - [`contrato-tarea-generico.md`](contrato-tarea-generico.md) — H1: define los 4
>   campos del contrato y, a alto nivel, cómo las fases lo consumen (§3). Este doc
>   es el **detalle mecánico** de ese §3.
> - [`ejecutor-provisioner-infra.md`](ejecutor-provisioner-infra.md) — H2: el
>   primer ejecutor no-código (`provisioner_infra`) y su registro `runExecutor`.
> - [`contrato-kernel-adaptador.md`](contrato-kernel-adaptador.md) — la frontera
>   kernel↔adaptador; el invariante de lifecycle (§5) que este wiring respeta.

---

## 1. Qué cambió (y qué NO)

**Antes.** La cadena de fases del pipeline `desarrollo`
(`validacion → dev → build → verificacion → linteo → aprobacion → entrega`)
asumía, **cableado**, que toda tarea produce un *diff de código*: `dev` creaba una
rama `agent/<issue>-<slug>` + worktree y spawneaba un agente LLM; `build` corría
`gradlew`; las fases post-dev reutilizaban el worktree del issue. Funciona para el
~95 % de las tareas porque casi todas producen código, pero deja en **limbo** las
que no (caso #4700).

**Ahora.** La cadena de fases **no cambia**. Cada fase, antes de asumir "código",
**lee el contrato de tarea** del issue (H1) y deriva su comportamiento según
`tipo_entregable` / `ejecutor`:

- **Contrato ausente o `tipo_entregable: codigo`** ⇒ comportamiento **idéntico al
  actual** (worktree + rama + agente LLM + `gradlew` + QA con video + PR).
  **Retrocompatibilidad total** — ningún issue existente cambia.
- **Contrato con ejecutor no-código** (p. ej. `provisioner_infra`) ⇒ el Pulpo
  resuelve la fase **determinísticamente**: sin worktree, sin LLM, sin gate de
  cuota. El ejecutor de H2 provisiona el recurso y produce la evidencia; las
  fases aguas abajo consumen esa evidencia o declaran un **no-op explícito**.

**No big-bang:** no se agregan ni quitan fases; una fase que no aplica a un
`tipo_entregable` declara `fase_noop: true` (queda registrado, no se saltea en
silencio). Así el lifecycle sigue siendo trazable y no reaparece el limbo de
#4700.

---

## 2. De dónde sale el contrato

`lib/task-contract.js` → `readTaskContract({ ROOT, PIPELINE, issue, workData })`
resuelve el contrato con esta prioridad (primer hit gana):

1. **Inline** en el work-file del ciclo: campo `contrato_tarea:` del YAML que
   viaja en `trabajando/`.
2. **Archivo por issue**: `.pipeline/contracts/<issue>.{yaml,yml,json}` (lo deja
   la fase de definición; **persiste entre fases**, por eso `verificacion` puede
   leer el mismo contrato que `dev`). Se acepta el contrato pelado o envuelto en
   `contrato_tarea:`.
3. **Ausente** ⇒ `null` ⇒ el kernel asume el contrato por defecto `codigo`
   (retrocompat).

Un contrato **presente pero corrupto** (parse error) **no** se degrada a "código"
en silencio: `readTaskContractDetailed` reporta el `error`, el Pulpo lo loguea y
—fail-safe— sigue con el flujo de código (regresión cero), dejando rastro para el
operador.

---

## 3. Cómo cada fase consume el contrato

La tabla detalla, por fase, qué mira del contrato y qué evidencia valida su gate.
La columna "código" es el comportamiento cableado de hoy (contrato ausente/código);
la columna "no-código" es el camino determinístico nuevo.

| Fase | Qué lee del contrato | Entregable **código** (hoy, sin cambios) | Entregable **no-código** (p. ej. `recurso_provisionado`) |
|------|----------------------|------------------------------------------|-----------------------------------------------------------|
| **validacion** | `definicion_de_listo`, `evidencia_requerida` | po/ux/guru validan alcance del cambio (LLM, corre en ROOT) | **Corre normal** (LLM): valida que el contrato sea verificable. No requiere worktree (precede a `dev`). |
| **dev** | `ejecutor.tipo` | Crea worktree + rama, spawnea el agente de código (`backend-dev`/…). | **Deriva al ejecutor** (`runExecutor`): provisiona el recurso y genera la evidencia (`describe_table_round_trip`). **Sin worktree ni LLM.** |
| **build** | `tipo_entregable` | `gradlew check` sobre el diff. | **No-op declarada** (`fase_noop: true`): el entregable no compila. Pasa registrando el motivo. |
| **verificacion** | `evidencia_requerida` | tester/security/qa (video E2E si hay UI). | **Consume la evidencia** del ejecutor y la compara con `definicion_de_listo` (round-trip completo ⇒ aprobado). |
| **linteo** | `tipo_entregable` | Chequeos mecánicos sobre el diff. | **No-op declarada**: no hay diff que lintear. |
| **aprobacion** | `definicion_de_listo` + evidencia | review/po/ux/architect sobre el PR. | **Verifica** `definicion_de_listo` contra la evidencia persistida. |
| **entrega** | `tipo_entregable` | delivery abre/mergea PR (`Closes #n`). | **Cierra el entregable sin PR** (`entregable_cerrado: true`): el recurso ya existe y respondió; no hay rama que mergear. |

**Principio rector (no big-bang):** una fase que no aplica declara un no-op
explícito, nunca un salto silencioso. El campo `fase_noop: true` en el work-file
lo hace auditable.

### 3.1. Flujo de la evidencia

La evidencia del ejecutor la produce **`dev`** y la persiste en
`.pipeline/evidence/<issue>.json` (además de viajar en el resultado). Las fases
`verificacion` / `aprobacion` / `entrega` la **leen desde ahí** — así la evidencia
sobrevive el salto entre fases (cada fase tiene su propio work-file). Para la
evidencia `describe_table_round_trip` (H2), "prueba el listo" significa round-trip
completo: `create && read && delete && confirmedGone`.

---

## 4. Punto de wiring en el Pulpo

El único punto de derivación vive al inicio de `lanzarAgenteClaude()`
(`.pipeline/pulpo.js`), **antes** del gate de cuota LLM:

```
lanzarAgenteClaude(skill, issue, trabajando, pipeline, fase, config)
  │
  ├─ readTaskContractDetailed({ ROOT, PIPELINE, issue, workData })
  │
  ├─ phaseHandledByContract(fase, contract)?
  │     ├─ NO  (código / ausente / fase=validacion) ─► flujo cableado intacto
  │     │        (gate cuota → worktree → spawn LLM → child.on('exit') → listo/)
  │     │
  │     └─ SÍ  (no-código, fase ∈ {dev,build,verificacion,linteo,aprobacion,entrega})
  │              ►  runContractPhase({ fase, contract, issue, ROOT, PIPELINE })
  │                 · dev          → runExecutor (provisión + evidencia)
  │                 · build/linteo → no-op declarada
  │                 · verif/aprob  → consume evidencia vs definicion_de_listo
  │                 · entrega      → cierra sin PR
  │              ►  el Pulpo escribe el resultado en el work-file
  │              ►  el Pulpo mueve trabajando/ → listo/  (único dueño del lifecycle)
  │              ►  el gate existente promueve a la fase siguiente como cualquier aprobado
```

**Invariante de lifecycle respetado** (contrato-kernel-adaptador §5): el
`runContractPhase` devuelve **datos** (`resultado` + evidencia); **nunca** mueve
archivos de estado. El Pulpo (kernel) es el único que promueve `trabajando/ →
listo/`.

**Por qué `validacion` queda fuera del camino determinístico:** precede a `dev`,
corre en ROOT (no necesita worktree) y valida el contrato mismo — puede seguir por
su camino normal (LLM) sin romper nada.

---

## 5. Retrocompatibilidad (CA-3) — por qué el 95 % no ve diferencia

- `phaseHandledByContract(fase, contract)` devuelve `false` para **todo** contrato
  de código o ausente ⇒ el intercept no aplica y el flujo cableado
  (worktree + rama + LLM + `gradlew` + QA + PR) corre **byte-por-byte** como antes.
- La derivación es **best-effort**: si la lectura del contrato o el require del
  módulo fallara, el Pulpo loguea y cae al flujo de código (regresión cero).
- El intercept se coloca antes del gate de cuota, pero **sólo actúa** para
  contratos no-código; los agentes de código siguen pasando por el gate de cuota
  y el dispatcher de provider exactamente igual.

---

## 6. Caso de validación: "crear una base de datos" (CA-4)

Contrato (en `.pipeline/contracts/<issue>.yaml`):

```yaml
tipo_entregable: recurso_provisionado
definicion_de_listo:
  - "La tabla existe con el schema pedido y responde a un round-trip"
evidencia_requerida:
  tipo: describe_table_round_trip
ejecutor:
  tipo: provisioner_infra
recurso:
  tipo: dynamodb_table
  nombre: ordenes-demo
  schema:
    hashKey:  { nombre: pk, tipo: S }
    rangeKey: { nombre: sk, tipo: S }
```

Recorrido por las fases (todas determinísticas, sin worktree ni LLM):

1. **validacion** (LLM, normal): valida que el contrato sea verificable.
2. **dev**: `runExecutor` provisiona la tabla y produce
   `describe_table_round_trip` (describe-table + smoke create/read/delete/confirm).
   Evidencia persistida en `.pipeline/evidence/<issue>.json`. → `aprobado`.
3. **build**: no-op declarada (no compila). → `aprobado` (`fase_noop`).
4. **verificacion**: lee la evidencia, verifica round-trip completo. → `aprobado`.
5. **linteo**: no-op declarada (sin diff). → `aprobado` (`fase_noop`).
6. **aprobacion**: `definicion_de_listo` vs evidencia. → `aprobado`.
7. **entrega**: cierra el entregable sin PR (`entregable_cerrado`). → `aprobado`.

El issue **recorre las mismas fases** que un cambio de código, pero cada fase sabe
—por el contrato— que **no** debe buscar una rama en `platform`. Se elimina la
causa raíz del limbo de #4700 ("ocupada sin rama" / "sin rama que validar").

---

## 7. Verificación

```bash
# Tests unitarios del wiring (derivación, lectura de contrato, runner por fase).
node --test .pipeline/lib/__tests__/task-contract.test.js

# Tests del ejecutor H2 (sin regresión).
node --test .pipeline/lib/__tests__/provisioner-infra.test.js

# Sintaxis del Pulpo tras el wiring.
node --check .pipeline/pulpo.js
```

**DoD (CA de #4719):**

- [x] Doc del pipeline actualizada: cada fase describe cómo lee el contrato (§3).
- [x] La fase `dev` deriva al ejecutor correcto según el contrato (§4, código vs
      provisioner) — `deriveDevWiring` / `phaseHandledByContract`.
- [x] Una tarea de código existente mantiene el flujo actual sin cambios de
      comportamiento (§5, retrocompat) — `phaseHandledByContract === false`.
- [x] El caso "crear una base de datos" recorre las fases usando el ejecutor de
      #4718 (§6) — `runContractPhase` + `runExecutor`.
