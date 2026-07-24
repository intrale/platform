# Plan de coexistencia kernel ↔ producto (Ola 8 · EP-OLA8-F · sub-track a)

> **Versión del documento:** 0.1.0 (definición viva — se revisa al entrar a Ola 9)
> **Estado:** definición (Ola 8). La Ola 8 **define**; la Ola 9 **implementa** con OK humano.
> **Naturaleza:** documento de **definición**. No hay código de auto-update/coexistencia en esta
> épica; el código recién se escribe en Ola 9. Cero riesgo para Intrale: el `.pipeline/` actual
> **no se toca**.

## Cómo leer este documento

Cubre el **sub-track (a)** del split de EP-OLA8-F: cómo conviven el **pipeline legacy de Intrale**
(`.pipeline/` embebido en el repo del producto) y el **kernel operativo nuevo** (repo aparte,
genérico), y cómo se hace el **cutover** de Intrale al kernel sin downtime ni riesgo. El sub-track
(b) — versionado, canal de update y la decisión de auto-hospedaje — vive en
[`kernel-updates.md`](./kernel-updates.md).

| Sección | Responde a | Criterios |
|---------|-----------|-----------|
| 1. Encuadre y supuestos consumidos | de dónde sale esto | CA-7, CA-8 |
| 2. Mapa qué-corre-dónde | qué corre en legacy vs kernel por etapa | CA-1 |
| 3. Paso a paso de transición | orden + gate de validación por etapa | CA-1, G1 |
| 4. Punto de cutover (freeze + ventana) | cómo se corta sin convivencia indefinida | CA-1 (R1) |
| 5. Contención de recursos (R2/RAM) | cómo no se cae la máquina con 2 pipelines | CA-1 (R2) |
| 6. Frontera de aislamiento | filesystem/estado/secretos separados | CA-2 (R4) |
| 7. Camino de fallo y rollback del cutover | qué hace el operador si una etapa falla | G2 |

---

## 1. Encuadre y supuestos consumidos (CA-7, CA-8)

### 1.1. Dependencias upstream consumidas

Este plan **consume** las salidas de las dos épicas bloqueantes de definición, ambas ya **CLOSED**:

| Upstream | Entregable consumido | Cómo lo usa este plan |
|----------|----------------------|-----------------------|
| **EP8-A · #4009** (inventario de frontera) | [`../desacople-kernel/inventario-frontera.md`](../desacople-kernel/inventario-frontera.md) — clasificación de skills/paths/docs/gates en kernel / adaptador / a-decidir | Define **qué se mueve** al kernel y qué queda en el adaptador → base del mapa "qué corre dónde" (sección 2). |
| **EP8-B · #4010** (contrato kernel↔adaptador) | [`contrato-kernel-adaptador.md`](./contrato-kernel-adaptador.md) — puertos, lifecycle, descubrimiento por manifiesto, decisión multi-tenant Modelo B | Define **a qué interfaz** se conecta Intrale en el cutover (puertos + manifiesto + `projectId`). |

**Acoplamiento fuerte (no bloqueante duro):** **EP8-D · #4012** (repo aparte + versionado), todavía
**OPEN**. Su esquema de versionado/distribución es **output conjunto** con el sub-track (b)
([`kernel-updates.md`](./kernel-updates.md)). Este plan de coexistencia consume sus **borradores
vivos** y marca abajo los supuestos provisionales. Si #4012 cambia su esquema de versionado, las
secciones de "qué versión del kernel se promueve en cada etapa" se revisan — no se reescribe el
cutover entero.

### 1.2. Supuestos vivos / provisionales

> Se marcan explícitamente porque #4012 sigue OPEN y porque el plan se escribe antes de que exista
> una sola línea de código del kernel.

- **[S1]** El kernel se distribuye como **release versionado e inmutable** (semver + tag), no como
  rama mutable. Detalle en [`kernel-updates.md`](./kernel-updates.md). *Provisional hasta #4012.*
- **[S2]** Intrale se conecta al kernel mediante el **manifiesto del adaptador**
  (`pipeline.config.json`, sección 6 del contrato), no por fork del kernel.
- **[S3]** El aislamiento multi-proyecto sigue el **Modelo B** del contrato (sección 8.1: un kernel
  multiplexa con estado namespaceado por `projectId`). La coexistencia legacy↔kernel es un **caso
  particular** de ese mismo contrato de aislamiento, no un esquema nuevo (ver sección 6).

### 1.3. Encuadre Ola 8 (CA-8)

- **Cero riesgo para Intrale:** el kernel se construye al lado, en repo nuevo. El `.pipeline/`
  actual del producto **no se toca** en esta épica ni durante el diseño de la coexistencia. Lo que
  se toca de `.pipeline/` recién ocurre en el **cutover de Ola 9**, con OK humano y con rollback
  preparado.
- **La Ola 8 define / la Ola 9 implementa:** la salida de esta épica son **definiciones + sub-épicas**
  (sección 9 del documento hermano y README del desacople). El código de cutover/coexistencia es
  Ola 9.
- **Sin label de admisión automático:** este issue **no recibe `Ready`/promoción automática** a
  implementación. La promoción a Ola 9 requiere **OK humano** (gate Ola 8).

---

## 2. Mapa qué-corre-dónde (CA-1)

Tabla de **qué sistema es autoritativo** para cada función operativa en cada etapa de la transición.
"Legacy" = `.pipeline/` embebido en el repo del producto Intrale (status quo). "Kernel" = kernel
operativo genérico nuevo (repo aparte) + adaptador Intrale.

> **Hecho base (verificado, inventario #4009 + guru):** hoy el pipeline **ya se auto-hospeda** — los
> issues `area:pipeline` (incluido este #4014) corren dentro del mismo Pulpo/agentes que operan
> producción. La coexistencia no introduce auto-hospedaje; **formaliza y aísla** el que ya existe.

| Función operativa | E0 · Pre-cutover (hoy) | E1 · Kernel en sombra | E2 · Kernel canary (subset) | E3 · Cutover (freeze) | E4 · Post-cutover |
|-------------------|------------------------|------------------------|------------------------------|-----------------------|-------------------|
| Intake de issues GitHub | **Legacy** | Legacy (kernel lee en read-only) | Legacy enruta; kernel toma subset etiquetado | **Kernel** | **Kernel** |
| Routing label→skill | Legacy (hardcoded) | Legacy | Kernel para subset (tabla inyectada por adaptador, crítico #1) | **Kernel** | **Kernel** |
| Ejecución de fases (dev/build/qa/...) | **Legacy** | Legacy | Kernel para issues canary | **Kernel** | **Kernel** |
| Estado FS (cola/olas/locks/métricas) | **Legacy** (`.pipeline/`) | Legacy autoritativo; kernel escribe en su **propio** árbol namespaceado | Ambos, **sin escritura cruzada** (sección 6) | **Kernel** (namespaceado por `projectId`) | **Kernel** |
| Secretos / credenciales | Loader único legacy (`.pipeline/lib/credentials.js`) | Legacy pleno; kernel con **scope mínimo** brokered | Kernel accede solo a los secretos del subset (sección 6.3) | Kernel brokered por `projectId` | Kernel brokered |
| Dashboard / chat operador | **Legacy** | Legacy + panel sombra read-only del kernel | Ambos con `projectId` visible (anti cross-talk) | **Kernel** | **Kernel** |
| Gates de QA de producto | **Legacy** | Legacy | Kernel invoca gates vía puerto `gates` del adaptador | **Kernel** (vía adaptador) | **Kernel** |
| `.pipeline/` legacy del producto | autoritativo | **read-only para el kernel** | **read-only para el kernel** | congelado (freeze) | **archivado** (no borrado) |

**Lectura de la tabla:** el kernel **nunca** es autoritativo sobre el estado del producto hasta E3.
Hasta el cutover, el kernel sólo **lee** lo legacy y **escribe** en su propio árbol. Esto materializa
"el `.pipeline/` legacy no se toca" como invariante verificable (sección 6) hasta el punto de corte.

---

## 3. Paso a paso de transición (CA-1, G1)

Cada etapa declara: **precondición observable** → **acción** → **criterio de validación de salida
(gate)** → **señal go/no-go**. No se avanza a la etapa N+1 sin el gate de N en verde. Formato
accionable (checklist), no narrativa (guideline G1 del `ux`).

### E0 · Pre-cutover — línea base congelada
- **Precondición:** kernel release `k-vX.Y.Z` publicado e inmutable ([S1]); manifiesto del adaptador
  Intrale (`pipeline.config.json`) escrito y validado contra el JSON Schema del contrato (sección 6.2
  de #4010).
- **Acción:** snapshot del estado legacy + tag estable del producto (`pipeline-stable`) como punto de
  retorno. Registrar versión del kernel pinneada para Intrale.
- **Gate de salida:** `test -f pipeline.config.json` y validación de schema OK; tag de retorno creado;
  inventario de issues en vuelo congelado.
- **Go/no-go:** ✅ go sólo si el manifiesto valida y el tag de retorno existe.

### E1 · Kernel en sombra (read-only)
- **Precondición:** E0 en verde.
- **Acción:** levantar el kernel apuntando al **mismo intake** de GitHub pero en modo **observador**:
  lee issues, calcula routing y plan, **no ejecuta** fases ni escribe en `.pipeline/` legacy. Escribe
  sólo en su árbol namespaceado (`projectId=intrale`).
- **Gate de salida:** durante una ventana de observación, el plan/routing del kernel **coincide** con
  el del legacy para los issues reales (diff de decisiones por debajo de umbral acordado); **cero**
  escrituras del kernel en el árbol legacy (verificable, sección 6.1).
- **Go/no-go:** ✅ go si coincidencia ≥ umbral y aislamiento FS confirmado; ❌ no-go → ajustar
  adaptador, no avanzar.

### E2 · Kernel canary sobre subset acotado
- **Precondición:** E1 en verde.
- **Acción:** mover un **subset etiquetado y reversible** de issues (p.ej. `area:pipeline` de bajo
  riesgo, o un label `kernel-canary`) a ejecución **real** por el kernel. El resto sigue en legacy.
  El subset y su tamaño se eligen para minimizar blast radius.
- **Gate de salida:** los issues canary completan su lifecycle por el kernel con resultado equivalente
  al esperado (mismas fases, gates de QA del producto en verde vía puerto `gates`); sin contaminación
  del estado legacy; `projectId` visible en toda superficie del operador (G3/UX multi-tenant).
- **Go/no-go:** ✅ go si el canary cierra limpio y el operador puede distinguir contexto; ❌ no-go →
  devolver el subset a legacy (reversible por diseño) y corregir.

### E3 · Cutover con freeze (punto de no-retorno)
- **Precondición:** E2 en verde + **OK humano explícito** (gate Ola 8) + ventana de cutover agendada.
- **Acción:** ver sección 4 (freeze + ventana acotada + corte). El kernel pasa a **autoritativo** para
  todo el producto; el `.pipeline/` legacy se **congela**.
- **Gate de salida:** el primer lote de issues post-cutover completa lifecycle por el kernel; smoke
  test del pipeline en verde; rollback **probado disponible** (no ejecutado).
- **Go/no-go:** ✅ go = cutover confirmado; ❌ no-go dentro de la ventana → rollback al estado legacy
  congelado (sección 7).

### E4 · Post-cutover — desmantelamiento ordenado del legacy
- **Precondición:** E3 estable durante una ventana de observación post-cutover.
- **Acción:** archivar el `.pipeline/` legacy (no borrar) como artefacto de auditoría; retirar el panel
  sombra; consolidar dashboard/chat sobre el kernel.
- **Gate de salida:** N días/lotes sin regresión atribuible al cutover; legacy archivado y referenciado
  en el log de auditoría ([`kernel-updates.md`](./kernel-updates.md), CA-5).
- **Go/no-go:** ✅ go = coexistencia cerrada; el producto corre 100% sobre kernel + adaptador.

> **Estado "dónde estoy" siempre visible (G1):** cada etapa tiene un marcador de **etapa activa /
> siguiente / punto de no-retorno (E3)** que el operador ve en el dashboard. El punto de no-retorno
> es E3; antes de E3 toda etapa es reversible.

---

## 4. Punto de cutover: freeze + ventana acotada (CA-1, mitiga R1)

**R1 — divergencia / doble mantenimiento:** mantener dos pipelines vivos indefinidamente duplica el
trabajo y abre drift entre ambos. **Mitigación anclada: el cutover es un evento acotado con freeze,
no una convivencia permanente.**

- **Freeze de cambios de proceso:** durante la ventana de cutover (E3) se **congela** todo cambio al
  modelo operativo de Intrale (no se mergean cambios a `.pipeline/` legacy ni al adaptador). Sólo se
  ejecuta el corte.
- **Ventana acotada y agendada:** el cutover ocurre en una ventana de tiempo definida y comunicada,
  no "cuando salga". Reusar el patrón de **ventanas autoexcluyentes** existente para no chocar con
  ventanas de QA/Build (ver sección 5).
- **Drenaje de in-flight antes del freeze:** los issues en vuelo en legacy se **drenan** (terminan su
  fase actual) o se **marcan reentrables** antes del corte; no se cortan a la mitad.
- **Criterio verificable de "fin de coexistencia":** la coexistencia se considera cerrada cuando E4
  pasa su gate; a partir de ahí **no existe el pipeline legacy** como sistema vivo (queda archivado).
  Esto evita la convivencia indefinida que dispara R1.

---

## 5. Contención de recursos (CA-1, R2/RAM) — decisión anclada

**R2 — la máquina ya aprieta con un pipeline.** Correr legacy + kernel en paralelo (E1–E3) duplica
la presión de RAM. Memoria operativa confirma: umbrales de presión recalibrados al baseline real de
RAM, devs concurrentes limitados a 2 (`project_resource-thresholds-recalibrated`); Gradle daemons
prohibidos (`--no-daemon` obligatorio).

**Decisión anclada (no diferida): extender el scheduler de ventanas autoexcluyentes a "ventanas por
pipeline", NO separar hardware.**

| Opción | Decisión | Razón |
|--------|----------|-------|
| **A · Extender ventanas autoexcluyentes a "ventanas por pipeline"** | ✅ **Elegida** | Reusa el scheduler existente (`QA > Build > Dev`, `project_priority-windows-v2`) y es **el mismo mecanismo** que el Modelo B del contrato (sección 8.1: scheduler único que reparte turnos por `projectId`). Coherente con "un kernel multiplexa". Costo de RAM sostenible. |
| **B · Separar hardware (segunda máquina)** | ❌ Descartada como default | Aísla físicamente pero introduce coste/infra nueva y no reusa nada; sólo se considera si E2 muestra que el multiplexado no alcanza. |

**Concretamente:**
- El scheduler trata a **legacy** y **kernel** como dos consumidores de turno excluyentes durante la
  coexistencia: en un instante dado **solo uno** ejecuta fases pesadas (build/QA), igual que hoy
  `QA > Build > Dev` no corren a la vez.
- Esto **converge** con el scheduler multi-tenant del kernel (Modelo B): coexistencia legacy↔kernel =
  caso de dos `projectId` (`intrale-legacy`, `intrale-kernel`) repartiendo turnos. **No se inventa un
  scheduler nuevo**; se generaliza el existente.
- El kernel en sombra (E1) corre en modo observador **liviano** (sin builds), por lo que su huella es
  baja hasta E2.

---

## 6. Frontera de aislamiento (CA-2, R4)

> Materializa los requisitos de seguridad #3 (aislamiento durante coexistencia) y #4 (exposición de
> secretos) del análisis de `security`, y el hecho #5 de `guru` (estado plano/global hoy). Es el
> mismo **contrato de aislamiento** del Modelo B (sección 8.1 de #4010), aplicado al caso de dos
> pipelines en un host — **no un esquema separado**.

### 6.1. Frontera de filesystem / estado (verificable)

- **Directorios separados, sin escritura cruzada.** El kernel escribe **exclusivamente** en su árbol
  namespaceado por `projectId`; nunca en el `.pipeline/` legacy del producto. El legacy escribe sólo
  en su árbol. La cola, `waves.json`, allowlist, locks y métricas se prefijan por `projectId` (hecho
  #5 de guru: hoy son planos/globales → se namespacean en el kernel).
- **Criterio verificable (CA-2 / seguridad #3 / G1):**

  ```bash
  # Durante E1–E3, el kernel NO escribe en el .pipeline/ legacy del producto.
  # (a) ninguna ruta de escritura del kernel resuelve dentro de .pipeline/ legacy
  # (b) auditoría de mtime: ningún archivo de .pipeline/ legacy cambia por acción del kernel
  #     fuera de la ventana de cutover E3.
  # Verificación de referencia (a instrumentar en Ola 9):
  #   - test de aislamiento que falla si el kernel abre un fd de escritura bajo el árbol legacy.
  #   - snapshot de hashes de .pipeline/ legacy antes/después de un ciclo del kernel en sombra → iguales.
  ```

  > Convertir el encuadre "el `.pipeline/` legacy no se toca / cero riesgo" en este **test de
  > aislamiento** es un criterio de aceptación de la sub-épica de Ola 9 (sección 8).

### 6.2. Scoping de secretos por pipeline (seguridad #3/#4)

- Hoy: **loader único** `.pipeline/lib/credentials.js` sobre `~/.claude/secrets/credentials.json`
  (fuente única, `feedback_credentials-unified`). Es el punto exacto a **particionar**.
- **Cada pipeline accede sólo a las credenciales que necesita.** El kernel genérico **no** tiene
  acceso amplio a los secretos del producto: recibe handles **brokered** (puerto `brokerSecret` del
  contrato, CA-11) scopeados por `projectId`. El adaptador Intrale es el único que conoce los secretos
  específicos de Intrale.
- **Separación kernel (sin secretos) ↔ adaptador (config/secretos del producto):** el artefacto
  distribuible del kernel **no contiene secretos** y pasa un **scan de secrets antes de publicar**
  (seguridad #4, detalle en [`kernel-updates.md`](./kernel-updates.md) §Distribución segura).

### 6.3. Frontera de contexto del operador (anti cross-talk, UX)

- `projectId` **visible y consistente** en dashboard, banners, chat y reportes durante la coexistencia
  (`intrale-legacy` vs `intrale-kernel`). El operador siempre ve en qué pipeline está parado.
- **Acciones destructivas/halt confirman el `projectId` afectado** en el mensaje (mismo espíritu que
  la allowlist actual). Un halt sobre el pipeline equivocado durante el cutover es el peor error
  posible.

---

## 7. Camino de fallo y rollback del cutover (guideline G2 del `ux`)

> El error y el rollback son parte de la UX, no un anexo. Se documentan con la misma prioridad que el
> camino feliz. Alinea con `feedback_rejection-reports-detail` (detalle no-técnico + clasificación de
> causa).

| Si falla en... | Qué ve el operador | Acción | Confirmación de éxito |
|----------------|--------------------|--------|------------------------|
| **E1 (sombra)** | Diff de decisiones kernel vs legacy fuera de umbral, o intento de escritura cruzada | Apagar el kernel sombra; legacy nunca dejó de ser autoritativo → **sin impacto en producción** | Legacy sigue corriendo; snapshot de hashes legacy intacto |
| **E2 (canary)** | Un issue canary falla/diverge | Devolver el subset a legacy (reversible por diseño); kernel vuelve a sombra | Subset re-procesado por legacy sin pérdida; estado legacy íntegro |
| **E3 (cutover)** | Smoke test post-cutover en rojo / primer lote falla | **Rollback atómico** al `.pipeline/` legacy **congelado** (no archivado aún): reusar `.pipeline/rollback.js` + `rollback.sh` y la convención de tags `*-stable` (punto de retorno de E0) | Legacy re-activado desde el freeze; smoke test verde; mensaje **inequívoco** (qué etapa falló, qué versión de kernel, qué se restauró) |

- **El legacy no se archiva hasta E4**, justamente para que el rollback de E3 tenga un destino vivo y
  congelado al que volver.
- **El mensaje/log que dispara el rollback es inequívoco y accionable** (G2): qué falló, qué versión
  del kernel estaba en juego, qué se restauró y cómo confirmar que el rollback funcionó.
- Detalle del mecanismo de rollback **atómico y verificable** (reuso de `rollback.js`/`rollback.sh` +
  tags estables): [`kernel-updates.md`](./kernel-updates.md) §Decisión auto-hospedaje y §Auditoría.

---

## 8. Salida hacia Ola 9 (CA-6) — qué implementa el sub-track (a)

La salida de esta definición son sub-issues de **implementación** (Ola 9), creadas con OK humano vía
`/planner split`. Este documento alimenta el **sub-track (a)** del split (el (b) lo alimenta
[`kernel-updates.md`](./kernel-updates.md)). Las sub-épicas de Ola 9 del track (a) **incorporan como
criterios de aceptación propios** los dominios de seguridad #3 (aislamiento) y #4 (secretos), y los
riesgos R1/R2/R4:

| Sub-issue Ola 9 (track a) | Alcance | Seguridad / riesgo embebido |
|---------------------------|---------|------------------------------|
| **Aislamiento de estado/FS por `projectId`** | Namespacing de cola/olas/locks/métricas + **test de aislamiento** que confirma que el kernel no escribe en `.pipeline/` legacy (sección 6.1) | seguridad #3, R4 |
| **Scoping de secretos por pipeline** | Particionar el loader único en handles brokered por `projectId` (sección 6.2) | seguridad #3/#4 |
| **Scheduler de ventanas por pipeline** | Extender ventanas autoexcluyentes a "ventanas por pipeline" = caso del scheduler multi-tenant Modelo B (sección 5) | R2 |
| **Máquina de cutover (E0–E4) + rollback** | Implementar las etapas con gates + rollback atómico reusando `rollback.js`/tags (secciones 3, 7) | R1 |

> Estas sub-épicas se mantienen **separadas** de las del sub-track (b) por ritmos de riesgo distintos
> (CA-6 / guru): el track (a) es coexistencia operativa; el (b) es seguridad de cadena de suministro.

---

## 9. Verificación (inspección estructural)

Al ser entregable documental, la verificación es por inspección (coherente con la nota del `po`:
criterios verificables por revisión documental).

```bash
cd "$(git rev-parse --show-toplevel)"

# CA-1 — existe y cubre qué-corre-dónde + paso a paso + cutover + decisión R2
test -f docs/pipeline/kernel-coexistencia.md
grep -n "Mapa qué-corre-dónde"      docs/pipeline/kernel-coexistencia.md
grep -n "Paso a paso de transición" docs/pipeline/kernel-coexistencia.md
grep -n "freeze + ventana acotada"  docs/pipeline/kernel-coexistencia.md
grep -n "ventanas por pipeline"     docs/pipeline/kernel-coexistencia.md   # decisión R2 anclada

# CA-2 — frontera filesystem/estado + scoping de secretos + criterio verificable "no toca legacy"
grep -n "Frontera de filesystem"        docs/pipeline/kernel-coexistencia.md
grep -n "Scoping de secretos"           docs/pipeline/kernel-coexistencia.md
grep -n "no escribe en el .pipeline/ legacy" docs/pipeline/kernel-coexistencia.md

# CA-7 — dependencias upstream documentadas (#4009/#4010 consumidas, #4012 acoplamiento)
grep -nE "#4009|#4010|#4012" docs/pipeline/kernel-coexistencia.md

# CA-8 — encuadre Ola 8 (cero riesgo, define/implementa, sin Ready automático)
grep -n "Cero riesgo para Intrale" docs/pipeline/kernel-coexistencia.md
grep -n "OK humano"                docs/pipeline/kernel-coexistencia.md
```

---

## Referencias

- [`../desacople-kernel/inventario-frontera.md`](../desacople-kernel/inventario-frontera.md) — EP8-A #4009 (qué es kernel / qué es adaptador).
- [`contrato-kernel-adaptador.md`](./contrato-kernel-adaptador.md) — EP8-B #4010 (puertos, manifiesto, Modelo B de aislamiento).
- [`kernel-updates.md`](./kernel-updates.md) — sub-track (b): versionado + canal de update + auto-hospedaje.
- `.pipeline/rollback.js` · `.pipeline/rollback.sh` — primitivas de rollback atómico reusadas en E3.
- `.pipeline/lib/credentials.js` — loader único a particionar (scoping de secretos).
