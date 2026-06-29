# Contrato kernel ↔ adaptador (Ola 8 · EP-OLA8-B)

> **Épica:** EP-OLA8-B · Contrato kernel↔adaptador (issue #4010)
> **Ola:** 8 — Definición del desacople kernel operativo ↔ producto
> **Naturaleza:** documento de **definición** (no implementación). Traza la frontera formal
> kernel↔adaptador y define la interfaz entre ambos. La Ola 8 **define**; la Ola 9 **implementa**.
> **Input directo:** [`docs/desacople-kernel/inventario-frontera.md`](../desacople-kernel/inventario-frontera.md) (EP-OLA8-A, #4009).
> **Estado:** documento vivo — se revisa al entrar a la Ola 9.
>
> **Versión del contrato:** `0.1.0` (semver) <!-- CA-1, CA-14 -->

---

## Cómo leer este documento

El **kernel operativo** es el motor genérico que orquesta agentes sobre *cualquier* producto:
no sabe nada de un stack concreto. El **adaptador de producto** es la capa que enseña al kernel
cómo es el producto específico (su stack, sus labels de dominio, sus comandos de build, sus
gates). Este contrato define **qué vive de cada lado** (sección 2), **qué le pide el kernel al
adaptador** (secciones 3–4), **cómo el kernel descubre y carga un adaptador** (sección 6) y
**qué garantías de seguridad y multi-tenant** son obligatorias desde el día uno (secciones 7–8).

Mapeo sección ↔ criterios de aceptación (CA del PO en #4010):

| Sección | CA cubiertos |
|---------|--------------|
| 1. Propósito y alcance | CA-1 |
| 2. Frontera kernel ↔ adaptador | CA-2, CA-3 |
| 3. Interfaz / puertos (Ports & Adapters) | CA-4 |
| 4. Puntos de extensión (hooks/capabilities) | CA-5 |
| 5. Invariante de lifecycle | CA-6 |
| 6. Descubrimiento y carga del adaptador | CA-7, CA-8 |
| 7. Seguridad incorporada | CA-9 … CA-14 |
| 8. Multi-tenant | CA-15 |
| 9. Salida y trazabilidad | CA-16, CA-17 |

---

## 1. Propósito y alcance

<!-- CA-1 -->

**Propósito.** Establecer el contrato técnico que separa el **kernel operativo genérico** del
**adaptador de producto**, de modo que el mismo motor de orquestación pueda conducir el ciclo de
vida de agentes sobre productos de cualquier stack sin reescribir su lógica.

**Alcance (qué define este documento).**

- La **frontera ítem por ítem** sobre el inventario de #4009 (sección 2).
- Los **puertos** que el kernel pide al adaptador, con firma conceptual (sección 3).
- Los **puntos de extensión** (hooks/capabilities) que el adaptador puede implementar (sección 4).
- El **invariante de lifecycle** del estado en filesystem (sección 5).
- El **mecanismo de descubrimiento y carga** declarativo del adaptador y su validación previa (sección 6).
- Los **requisitos de seguridad** de la frontera, con mapeo OWASP (sección 7).
- El **modelo multi-tenant** por `projectId` y la decisión de aislamiento (sección 8).
- La **salida** (sub-issues de Ola 9) y la reafirmación de **cero riesgo** para el producto (sección 9).

**Fuera de alcance (qué NO define).**

- Implementación de código del kernel o del adaptador (eso es **Ola 9**).
- Migración o refactor de skills/`config.yaml`/hooks existentes (Ola 9).
- Comandos concretos de un stack particular (gradle, emulador, Lambda): aparecen sólo como
  **ejemplo** del adaptador, nunca como requisito del kernel.

**Naturaleza.** Diseño, no código. El único artefacto productivo de esta épica es este
documento (más, en Ola 9, las sub-issues que enumera la sección 9).

---

## 2. Frontera kernel ↔ adaptador

<!-- CA-2, CA-3 -->

La tabla siguiente traza la frontera **ítem por ítem** sobre el inventario de #4009. Cada ítem
del inventario aparece **exactamente una vez** con su lado asignado y una justificación de una
línea. Valores de la columna **Lado**:

- **kernel** — lógica genérica de orquestación; se muda al kernel sin conocer el producto.
- **adaptador** — conocimiento de producto (stack, dominio, build, auth); vive del lado adaptador.
- **a-decidir** — híbrido: mezcla regla genérica + conocimiento de producto; se **parte a nivel
  de regla/sección en la Ola 9**. El *mecanismo* va al kernel; el *contenido* al adaptador.

> **Invariante de frontera (CA-3):** ninguna fila marcada **kernel** referencia el producto por
> nombre. Verificable con `grep` (ver sección "Verificación"). Las filas que sí nombran el
> producto son, por construcción, **adaptador** o **a-decidir**.

### 2.1. Skills acoplados al producto — inventario §1.1

| Ítem (skill) | Lado | Justificación (1 línea) |
|--------------|------|-------------------------|
| `web-dev` | adaptador | Stack del producto (Wasm/PWA/Webpack); 47 matches de stack. |
| `android-dev` | adaptador | Stack del producto (Compose, flavors, Coil); 32 matches. |
| `backend-dev` | adaptador | Stack + auth del producto (Ktor, Lambda, DynamoDB, Cognito); 21 matches. |
| `tester` | adaptador | Cobertura sobre el stack del producto (Kover, kotlin-test, Gradle); 18 matches. |
| `perf` | adaptador | Performance de builds y módulos del stack del producto (Gradle); 18 matches. |
| `builder` | adaptador | Comandos de build del producto (gradlew, APK por flavor); 17 matches. |
| `ux` | adaptador | Produce assets visuales del producto (Compose, branding por flavor); 25 matches. |

### 2.2. Skills de orquestación e híbridos — inventario §1.2

| Ítem (skill) | Lado | Justificación (1 línea) |
|--------------|------|-------------------------|
| `delivery` | kernel | Commit + push + PR; mecanismo genérico, las convenciones de rama/assignee se parametrizan. |
| `branch` | kernel | Gestión de ramas y protección de la rama base; git puro, genérico. |
| `cost` | kernel | Token cost tracker por sesión/agente; métrica de orquestación agnóstica. |
| `handoff` | kernel | Postea payload de delivery en el issue; mecanismo genérico de traspaso. |
| `reset` | kernel | Hard reset de la infra de orquestación; opera sobre el motor, no sobre el producto. |
| `ops` | kernel | Validación/diagnóstico del entorno de ejecución; genérico. |
| `auth` | kernel | Permisos del harness (Claude Code); genérico, no es auth de producto. |
| `monitor` | kernel | Dashboard de semáforos multi-sesión; orquestación pura. |
| `ghostbusters` | kernel | Limpieza de procesos zombi/worktrees/locks; higiene del motor. |
| `pipeline-dev` | kernel | Desarrolla el orquestador mismo; es el dev del propio kernel. |
| `refinar` | a-decidir | Refinamiento de issues genérico; embebe labels y tablero del producto. |
| `po` | a-decidir | Plantilla de gates (kernel) con contenido de negocio del producto. |
| `priorizar` | a-decidir | Triaje masivo genérico; las categorías/labels son del producto. |
| `review` | a-decidir | Code review genérico; las reglas citadas (strings, recursos) son del producto. |
| `guru` | a-decidir | Investigación técnica genérica; el codebase investigado es el producto. |
| `security` | a-decidir | Marco OWASP genérico; las referencias de auth concretas son del producto. |
| `planner` | a-decidir | Planificación genérica; sprints/historias y stack referenciado son del producto. |
| `historia` | a-decidir | Plantilla de historias genérica; labels de admisión y stack embebido son del producto. |
| `doc` | a-decidir | Gestión de backlog genérica; labels/áreas del producto embebidas en el ruteo. |
| `qa` | a-decidir | Híbrido fuerte; se parte regla por regla en §2.6 (proceso=kernel, ejecución=adaptador). |

### 2.3. Contenedor `_frozen` — inventario §1.3

| Ítem (skill congelado) | Lado | Justificación (1 línea) |
|------------------------|------|-------------------------|
| `_frozen/desktop-dev` | adaptador | Stack del producto (Compose Desktop/JVM); congelado. |
| `_frozen/ios-dev` | adaptador | Stack del producto (Compose iOS); congelado. |
| `_frozen/scrum` | kernel | Proceso de orquestación (zombi V3); congelado, genérico. |

### 2.4. `config.yaml` — inventario §2.1

| Ítem (sección/regla) | Lado | Justificación (1 línea) |
|----------------------|------|-------------------------|
| `dev_skill_mapping` (ruteo label→skill) | adaptador | Mapea labels de dominio del producto a skills de stack; es inyectable por el adaptador (crítico #1). |
| `dev_routing_priority` (orden de labels) | a-decidir | El mecanismo de prioridad es genérico; la lista concreta de labels es del producto. |
| `pipeline_scope_keywords` (heurística de override) | a-decidir | Mecanismo de override genérico; las keywords mezclan motor y producto. |
| `dev_skill_mapping.default` (fallback de skill) | adaptador | El fallback asume un área por defecto del stack del producto. |
| Límites de concurrencia / umbrales de recursos | a-decidir | El throttling es genérico; los valores calibrados al hardware/stack son del producto. |
| Artefactos QA (`types/formats`) | kernel | Tipos de artefacto genéricos (video/document, formatos); reutilizables. |

### 2.5. `CLAUDE.md` y `.pipeline/*.js` + hooks — inventario §2.2 y §2.3

| Ítem | Lado | Justificación (1 línea) |
|------|------|-------------------------|
| `CLAUDE.md`: Stack y versiones | adaptador | Stack del producto; 100% adaptador. |
| `CLAUDE.md`: Comandos de build | adaptador | Comandos del build del producto (gradle/flavor/shadowJar). |
| `CLAUDE.md`: Arquitectura App/Backend | adaptador | Patrones de código del producto. |
| `CLAUDE.md`: Reglas de strings/recursos | adaptador | Regla de implementación del producto (KSP, resString, fallback ASCII). |
| `CLAUDE.md`: Product Flavors | adaptador | Dominio del producto (variantes de app). |
| `CLAUDE.md`: Ramas y PRs | a-decidir | Convención de ramas genérica; nombres/bases concretos se parametrizan. |
| `CLAUDE.md`: Gate de QA obligatorio | a-decidir | Secuencia de gates y labels de proceso son genéricos; el criterio por tipo cita el stack. |
| `CLAUDE.md`: Protocolo de tareas / concurrencia | kernel | Mecanismo de orquestación (tasks, hooks, límite de agentes); genérico. |
| `CLAUDE.md`: Lanzamiento de agentes (Pulpo, worktrees, circuit breaker) | kernel | Descripción del motor operativo; genérico salvo paths del repo. |
| `.pipeline/pulpo.js`/`dashboard.js`/libs — lógica de orquestación | kernel | Motor del pipeline (intake, colas, lifecycle, routing); genérico. |
| Convención de rama `agent/*` hardcodeada en JS | a-decidir | Mecanismo de ramas genérico; el patrón concreto debe ser config. |
| Worktrees aislados (`worktree-guard.js`, `cleanup-worktrees.js`) | a-decidir | Aislamiento genérico; asume hoy que el repo orquestado **es** el repo del motor. |
| `.pipeline/` embebido dentro del repo del producto | adaptador | Acoplamiento estructural: el estado del motor vive en el repo orquestado (crítico #2). |
| `agent-concurrency-check.js`/`agent-registry.js`/`activity-logger.js` | kernel | Hooks de orquestación/telemetría; genéricos. |
| `apk-freshness.js` (hook) | adaptador | Conoce el artefacto empaquetado del producto. |

### 2.6. Frontera de secretos y auth — inventario §3

| Ítem | Lado | Justificación (1 línea) |
|------|------|-------------------------|
| Mecanismo de carga de credenciales (`lib/credentials.js`) | kernel | Cargador unificado (precedencia env > json > legacy); mecanismo genérico. |
| Nombres / scopes de credenciales concretos | adaptador | Los *qué* credenciales y sus scopes son del entorno del producto. |
| Auth del producto (JWT / Cognito / `SecuredFunction`) | adaptador | Patrones de autenticación del producto; no suben al kernel. |
| Redacción de secretos en handoff (`lib/handoff.js` + `lib/redact.js`) | kernel | Higiene genérica (redacta keys/JWT/passwords + anti prompt-injection). |

### 2.7. Gates de QA — inventario §4

| Ítem (regla) | Lado | Justificación (1 línea) |
|--------------|------|-------------------------|
| `qa`: "feature con UI → E2E con video obligatorio" | kernel | Regla de proceso genérica; aplica a cualquier producto con UI. |
| `qa`: secuencia "QA E2E → Tester → PO acceptance" | kernel | Flujo de validación genérico. |
| `qa`: labels de proceso `qa:passed/skipped/pending` | kernel | Semántica de estado de proceso; reutilizable. |
| `qa`: criterio "infra/docs sin label de app → skip E2E" | a-decidir | El principio es genérico; los labels que lo disparan son del producto. |
| `qa`: ejecución con emulador del stack móvil | adaptador | Stack de ejecución específico del producto. |
| `qa`: artefacto empaquetado por variante (APK por flavor) | adaptador | Build del producto. |
| `qa`: narración TTS / Lambda / auth en entorno QA remoto | adaptador | Infra/stack del producto. |
| `config.yaml`: umbrales `qa_env_max_*`, `qa:1`, duración ventana QA | a-decidir | El throttling es genérico; los valores calibrados al stack son del producto. |

### 2.8. Acoplamientos críticos (top-3 del inventario §6 → drivers del contrato)

Estos tres tienen tratamiento explícito en las secciones de interfaz/descubrimiento:

1. **Ruteo `label→skill`** → el kernel expone el **puerto de descubrimiento de trabajo** y la
   tabla de ruteo la **inyecta el adaptador** vía manifiesto (sección 3 y 6). No se hardcodea.
2. **`.pipeline/` embebido en el repo orquestado** → la sección 5 (lifecycle) y la sección 8
   (multi-tenant) definen el estado del motor como **propiedad del kernel**, namespaceado por
   `projectId`, separable del repo orquestado.
3. **Conocimiento de stack en skills dev/qa/ux** → la sección 4 define la **interfaz de
   capabilities** que el kernel espera de un "skill de desarrollo/QA/UX" para enchufar adaptadores
   de otros stacks.

---

## 3. Interfaz / puertos (Ports & Adapters)

<!-- CA-4 -->

El kernel define **puertos** (interfaces que necesita); el adaptador los **implementa** con su
stack. La firma es **conceptual** (entradas/salidas/errores), no una API de un lenguaje concreto.
Ningún ejemplo de implementación (build de un stack, emulador, despliegue a un cloud) es parte
del puerto: son ejemplo del adaptador.

> **Convención de firma.** Cada puerto recibe un **contexto de invocación** (`projectId`,
> `workItemRef`, handles de capacidad acotados — ver sección 4 y 7) y devuelve un **resultado
> estructurado** con `status` (`ok|failed|skipped`), `artifacts[]` y `diagnostics[]`. Los errores
> se modelan como datos en el resultado (`status: failed` + `diagnostics`), no como excepciones
> de stack que crucen la frontera.

| Puerto | Entradas (conceptuales) | Salidas | Errores | Oblig/Opc |
|--------|-------------------------|---------|---------|-----------|
| `discoverWork` | fuente de trabajo + filtros declarativos (labels/criterios de admisión del adaptador) | lista de `workItemRef` normalizados (id, tipo, prioridad) | fuente inalcanzable; filtro inválido | **Obligatorio** |
| `route` | `workItemRef` + tabla de ruteo del adaptador | `skill/capability` destino | sin regla aplicable → fallback declarado | **Obligatorio** |
| `build` | `workItemRef` + workspace | `status` + artefactos de build + logs | compilación fallida (como dato) | **Obligatorio** |
| `test` | `workItemRef` + workspace | `status` + reporte de cobertura/resultados | tests fallidos; entorno no preparado | **Obligatorio** |
| `e2e` | `workItemRef` + artefacto empaquetado + entorno objetivo | `status` + evidencia (video/doc) | entorno no disponible; fallo de escenario | Opcional (según capability del adaptador) |
| `package` | artefactos de build + perfil/variante | artefacto empaquetado (referencia, no bytes en banda) | empaquetado fallido | Opcional |
| `deploy` | artefacto empaquetado + destino | `status` + referencia de despliegue | destino inalcanzable; credencial insuficiente | Opcional |
| `gates` | `workItemRef` + estado de validación acumulado | veredicto de gate (`pass/fail/skip`) + razón | criterio no evaluable | **Obligatorio** |

**Notas de diseño.**

- Los **7 puertos mínimos** que exige CA-4 son: `build`, `test`, `e2e`, `package`, `deploy`,
  `discoverWork` (descubrimiento de trabajo) y `gates`. `route` se agrega por ser el punto crítico #1
  del inventario; es obligatorio porque sin él el kernel no sabe a qué capability mandar el trabajo.
- Un adaptador declara en su manifiesto **qué puertos opcionales implementa** (capabilities). El
  kernel sólo invoca puertos declarados; los no implementados se resuelven como `skipped` con razón.
- Las firmas evitan a propósito cualquier tipo concreto de stack: no hay "task de gradle", "AVD"
  ni "función Lambda" en el puerto — esos son detalles del adaptador.

---

## 4. Puntos de extensión (hooks / capabilities)

<!-- CA-5 -->

Más allá de los puertos, el adaptador puede implementar **hooks** que el kernel invoca en momentos
definidos del ciclo. Cada hook declara: **cuándo** lo invoca el kernel, el **contrato de datos** de
ida y vuelta, y si es **obligatorio u opcional**. El kernel pasa a cada hook **sólo los handles de
capacidad necesarios** (capability-based, ver sección 7), nunca el entorno entero.

| Hook / capability | Cuándo lo invoca el kernel | Datos de ida → vuelta | Oblig/Opc |
|-------------------|----------------------------|------------------------|-----------|
| `onWorkDiscovered` | tras `discoverWork`, antes de encolar | `workItemRef[]` → `workItemRef[]` normalizados/filtrados | Opcional |
| `resolveRouting` | al rutear un ítem | `workItemRef` + tabla de ruteo declarativa → `capabilityId` | **Obligatorio** |
| `prepareWorkspace` | antes de `build`/`test` | `workItemRef` + ref de workspace acotado → `status` | Opcional |
| `provideCapability(id)` | al necesitar un puerto opcional | `invocationContext` acotado → `result` del puerto | Opcional (según capabilities declaradas) |
| `evaluateGate(id)` | en cada gate del flujo | estado de validación → veredicto `pass/fail/skip` + razón | **Obligatorio** |
| `brokerSecret(scope)` | cuando un puerto necesita un secreto | `scope` puntual → secreto de scope acotado (brokereado por el kernel) | Opcional |
| `decorateArtifact` | al publicar un artefacto/reporte | `artifactRef` → metadata adicional (sin mutar el lifecycle) | Opcional |
| `describeProject` | al iniciar el contexto de un `projectId` | — → metadata de proyecto (nombre visible, etiquetas de UI) | Opcional |

**Reglas de los hooks.**

- **Contrato de datos explícito y validado:** cada hook tiene un esquema de ida/vuelta. El kernel
  valida la respuesta contra el esquema; una respuesta fuera de contrato se trata como fallo del
  adaptador (no se ejecuta a ciegas).
- **Sin acceso al lifecycle:** ningún hook puede mover archivos de estado entre carpetas (ver
  sección 5). `decorateArtifact` agrega metadata, no promueve estado.
- **Capacidad mínima:** el handle que recibe un hook expone sólo lo que su contrato declara
  (p. ej. `brokerSecret` recibe la capacidad de *pedir* un secreto puntual, no de leer el store).

---

## 5. Invariante de lifecycle

<!-- CA-6 -->

El ciclo de vida del estado en filesystem —

```
pendiente/ → trabajando/ → listo/ → procesado/
```

— es **propiedad exclusiva del kernel**. Es el mismo invariante que rige hoy ("el Pulpo es el
único dueño del lifecycle del archivo"). El contrato lo eleva a regla formal de la frontera:

- **El adaptador pide; el kernel ejecuta.** El adaptador puede *solicitar* trabajo, *reportar*
  resultados (vía el `result` de los puertos) y *decorar* artefactos, pero **nunca** mueve un
  archivo de estado entre carpetas ni escribe directamente en las colas del kernel.
- **El estado FS está fuera del alcance de escritura del adaptador** (alineado con CA-10). El
  adaptador opera sobre su **workspace** (acotado, ver sección 7), no sobre `pendiente/` /
  `trabajando/` / `listo/` / `procesado/`.
- **Transiciones atómicas.** Las promociones de estado las realiza el kernel con `rename`
  atómico, de forma idempotente. El adaptador que intente cortocircuitar esto produce una
  condición de carrera — por eso el contrato lo prohíbe explícitamente.
- **Un solo dueño por transición.** No hay escritura concurrente kernel↔adaptador sobre el mismo
  archivo de estado: el adaptador devuelve datos; el kernel decide la transición.

Este invariante es lo que permite que el motor sea genérico: el lifecycle no depende de qué hace
el adaptador, sólo de los `result` que devuelve.

---

## 6. Descubrimiento y carga del adaptador

<!-- CA-7, CA-8 -->

### 6.1. Descubrimiento declarativo (CA-7)

El kernel descubre y carga un adaptador a través de un **manifiesto declarativo**
`pipeline.config.json`, no mediante `require()`/`import` dinámico de paths arbitrarios.

```jsonc
// pipeline.config.json (forma conceptual)
{
  "contractVersion": "0.1.0",        // semver del contrato que el adaptador implementa
  "projectId": "acme-store",         // identidad multi-tenant (sección 8)
  "displayName": "ACME Store",       // metadata para UI del operador
  "capabilities": {                   // qué puertos opcionales implementa
    "e2e": true,
    "package": true,
    "deploy": false
  },
  "routing": [                        // tabla de ruteo inyectada (crítico #1)
    { "match": { "label": "area:api" }, "capability": "backend" },
    { "match": { "label": "area:web" }, "capability": "web" }
  ],
  "extensionPoints": ["resolveRouting", "evaluateGate", "prepareWorkspace"],
  "integrity": {                      // ver 6.2
    "algorithm": "sha256",
    "checksum": "<hash del manifiesto/bundle>"
  }
}
```

**Prohibiciones explícitas (CA-7).**

- **PROHIBIDO** `require()`/`import` dinámico de paths arbitrarios o controlados por entrada externa.
- **PROHIBIDO** que el path del adaptador provenga de entrada no validada (issue body, labels,
  mensajes de chat). El kernel resuelve el adaptador desde una **ubicación registrada** (allowlist
  de proyectos), no desde datos en banda.
- Las capabilities y puntos de extensión que el kernel invoca son **únicamente** los declarados en
  el manifiesto; cualquier otro se ignora.

### 6.2. Validación previa a la carga (CA-8)

Antes de cargar un adaptador, el kernel valida —en este orden, abortando al primer fallo:

1. **Compatibilidad de versión de contrato.** `contractVersion` del manifiesto debe ser
   compatible con la versión del kernel según semver (ver sección 7, CA-14). Mismatch
   incompatible → **rechazo de carga** con error accionable (versión soportada vs encontrada).
2. **Integridad del manifiesto/bundle.** Verificación por **checksum / firma / allowlist** según
   el `integrity` declarado. El adaptador se trata como **dependencia supply-chain**: un manifiesto
   cuyo checksum no coincide con el registrado no se carga.
3. **Validación de esquema del manifiesto.** El manifiesto valida contra un **JSON Schema**
   publicado del contrato (DX: errores accionables, ver sección 6.3). Campos requeridos:
   `contractVersion`, `projectId`, `capabilities`, `extensionPoints`.
4. **Sanitización de la config declarativa** (labels, ramas, comandos de gate, paths) — ver
   CA-12. Los paths se validan contra path traversal **antes** de usarse como base de workspace.

El ciclo descubrir → validar → cargar expone **estados observables** (`descubierto` /
`validando` / `rechazado` / `cargado`) para el operador (DX, sección 6.3).

### 6.3. Consideraciones de UX/DX del operador

> Guidelines del agente `ux` (fase definición) — refuerzan legibilidad y observabilidad; se
> propagan como criterios a las sub-issues de Ola 9 (sección 9), no son nuevos requisitos
> funcionales.

- **Manifiesto autodescriptivo y validable:** publicar un **JSON Schema** referenciable del
  `pipeline.config.json` para que el integrador tenga autocompletado/validación en su editor.
- **Errores de validación accionables:** ante manifiesto inválido o mismatch de versión, el kernel
  responde *qué* campo falló, *valor esperado* y *cómo corregir*; nunca fallo silencioso ni stack
  trace crudo. El rechazo por versión nombra la versión soportada y la encontrada.
- **Carga con estados observables:** el operador ve `descubierto/validando/rechazado/cargado`, no
  un binario "anda / no anda".

---

## 7. Seguridad incorporada

<!-- CA-9 .. CA-14 -->

Los seis requisitos del agente `security` (fase definición) son **requisitos de diseño de la
frontera**, no defectos. Cada uno se mapea a OWASP y se propaga como criterio a las sub-issues de
Ola 9 (sección 9).

### CA-9 · Límite de confianza en la carga (OWASP A08 Software & Data Integrity, A06 Vulnerable Components)

Cargar un adaptador = ejecutar código de terceros con los privilegios del kernel. El contrato lo
trata como **límite de confianza explícito**: descubrimiento por manifiesto (6.1) + validación
previa de versión e integridad (6.2). Sin manifiesto válido y verificado, no hay carga.

### CA-10 · Capability-based, mínimo privilegio (OWASP A01 Broken Access Control, A04 Insecure Design)

El kernel pasa al adaptador **sólo los handles que necesita** (broker de secretos, workspace
acotado), nunca el entorno entero (filesystem completo, token de la forja, red abierta). El estado
FS del kernel (`pendiente/`/`trabajando/`/`listo/`/`procesado/`) queda **fuera del alcance de
escritura** del adaptador (invariante de la sección 5). Cada hook recibe una capacidad acotada a
su contrato (sección 4).

### CA-11 · Brokering de secretos (OWASP A02 Cryptographic Failures, A01)

El adaptador **no** lee el store de credenciales del operador ni inyecta secretos por su cuenta. El
kernel actúa de **broker**: resuelve y entrega **el secreto puntual** necesario para una operación,
con **scope acotado** y vida limitada a esa operación (hook `brokerSecret`, sección 4). Los
*nombres y scopes* de credenciales son del adaptador (sección 2.6); el *mecanismo* de brokering es
del kernel.

### CA-12 · Sanitización de config declarativa (OWASP A03 Injection + path traversal)

Labels, nombres de rama, comandos de gate y rutas que el adaptador aporta como config terminan
usándose en operaciones de forja, git y shell. El contrato exige tratarlos como **datos**
(parametrizados/escapados), **nunca** interpolados en shell. Los **paths** del adaptador se validan
contra **path traversal** antes de usarse como base de estado/escritura (refuerza 6.2 paso 4).

### CA-13 · Integridad anti prompt-injection del canal (OWASP A03, alineado con #2993)

Todo dato que cruce kernel↔adaptador y termine en un **prompt de agente** (config, descripciones,
capabilities, secciones de handoff) pasa por las **mismas defensas anti prompt-injection y
redacción de secretos** del módulo de handoff (`lib/redact.js`, ver sección 2.6, lado kernel). El
contrato declara este saneo como **obligación de la frontera**, no opcional.

### CA-14 · Versionado del contrato (OWASP A04, A08)

El contrato declara un campo de **versión semver** (`contractVersion`, hoy `0.1.0`). Ante
**mismatch incompatible** el kernel **rechaza la carga** del adaptador (no asume garantías que ya
no da). Política de cambios:

- **PATCH** (`0.1.x`): aclaraciones, sin cambio de contrato observable.
- **MINOR** (`0.x.0`): puertos/hooks **nuevos opcionales**; retrocompatible.
- **MAJOR** (`x.0.0`): cambio incompatible (puerto/hook obligatorio nuevo o firma cambiada); el
  kernel rechaza adaptadores con MAJOR distinto.

---

## 8. Multi-tenant

<!-- CA-15 -->

El multi-tenant es **dimensión de primera línea**, no fase 2. El contrato namespacea estado y
recursos por **`projectId`** desde el día uno.

**Recursos namespaceados por `projectId`:** cola de trabajo, olas, worktrees, métricas, locks y
canal de chat del operador. El `projectId` proviene del manifiesto (sección 6.1) y acompaña el
`invocationContext` de todo puerto/hook.

### 8.1. Decisión de aislamiento anclada

Dos modelos posibles:

| Modelo | Cómo aísla | Costo | Riesgo |
|--------|-----------|-------|--------|
| **A · Nivel proceso** (N pipelines) | un proceso kernel por proyecto | alto en RAM (la máquina ya aprieta con 2 pipelines) | bajo (aislamiento físico) |
| **B · Nivel datos** (1 kernel multiplexa) | un kernel con estado namespaceado por `projectId` + scheduler único que reparte turnos | bajo en RAM | medio (requiere disciplina de namespacing y aislamiento lógico estricto) |

**Recomendación (anclada, no diferida): Modelo B.** Estado por-proyecto + **scheduler único** que
reparte turnos reusando el patrón de ventanas autoexcluyentes (QA > Build > Dev). Razón: la máquina
no soporta N procesos kernel completos en paralelo; el multiplexado con estado namespaceado da el
aislamiento necesario a un costo de RAM sostenible. El aislamiento lógico se apoya en: claves de
estado prefijadas por `projectId`, locks por `projectId`, y separación de contexto en el chat del
operador.

### 8.2. Desambiguación multi-tenant en superficies del operador

> Guidelines del agente `ux` — el mayor riesgo de UX multi-tenant es **actuar sobre el proyecto
> equivocado**. Se propagan a Ola 9 (sección 9).

- **`projectId` visible y consistente** en toda superficie operador-facing (dashboard, banners,
  mensajes de chat, reportes). No basta namespacear por dentro: el operador tiene que *ver* en qué
  proyecto está parado.
- **Acciones destructivas/halt confirman el `projectId` afectado** en el mensaje (mismo espíritu
  que la allowlist actual).
- Con multiplexado (Modelo B), el chat del operador **distingue contexto por proyecto** para evitar
  cross-talk.

---

## 9. Salida y trazabilidad

<!-- CA-16, CA-17 -->

### 9.1. Sub-issues de Ola 9 (CA-16)

La salida de esta épica de **definición** son las sub-issues de **implementación** (Ola 9), cada
una con los criterios de seguridad **CA-9..CA-14 ya volcados como criterios de aceptación propios**
(no como parche posterior). Lista propuesta (se crean al aprobar este contrato, con OK humano):

| Sub-issue (Ola 9) | Alcance | Criterios de seguridad embebidos |
|-------------------|---------|----------------------------------|
| **O9-1 · Loader de adaptador por manifiesto** | Implementar descubrimiento declarativo `pipeline.config.json` + JSON Schema publicado (secciones 6.1, 6.3) | CA-9, CA-12, CA-13 |
| **O9-2 · Validación previa a la carga** | Compatibilidad de versión + integridad (checksum/firma/allowlist) + sanitización (sección 6.2) | CA-8→CA-9, CA-12, CA-14 |
| **O9-3 · Puertos del kernel (Ports & Adapters)** | Definir/implementar los 8 puertos con firma conceptual (sección 3) | CA-10, CA-13 |
| **O9-4 · Capability handles + broker de secretos** | Hooks con capacidad mínima + `brokerSecret` (secciones 4, 7) | CA-10, CA-11, CA-13 |
| **O9-5 · Invariante de lifecycle aislado del adaptador** | Garantizar que el adaptador no escribe el estado FS (sección 5) | CA-10 |
| **O9-6 · Multi-tenant por `projectId`** | Namespacing de estado/recursos + scheduler único (Modelo B) + visibilidad de `projectId` (sección 8) | CA-10, CA-12, CA-13 |
| **O9-7 · Tabla de ruteo inyectable** | Mover `label→skill` del kernel a la config del adaptador (crítico #1) | CA-12, CA-13 |

Cada sub-issue nace con: criterios de seguridad listados arriba como CA propios, referencia a la
sección correspondiente de este contrato, y la versión de contrato (`contractVersion`) que asume.

### 9.2. Cero riesgo para el producto (CA-17)

- El kernel operativo se construye **al lado, en un repo nuevo**. El `.pipeline/` actual del
  producto **no se toca** en esta ola.
- Este entregable es **diseño** (un documento bajo `docs/`), no código. Cualquier edición fuera de
  `docs/` en esta épica es **scope leak** y motivo de rechazo.
- Verificable: el PR de esta épica sólo toca `docs/pipeline/contrato-kernel-adaptador.md` y el
  índice de `docs/desacople-kernel/README.md` (link de navegación). Cero archivos bajo `.pipeline/`.

---

## Verificación (inspección estructural)

Al ser un entregable documental, la verificación es por inspección. Comandos de referencia:

```bash
# CA-1, CA-14 — el documento existe y declara versión semver
test -f docs/pipeline/contrato-kernel-adaptador.md && grep -n "Versión del contrato" docs/pipeline/contrato-kernel-adaptador.md

# CA-3 — ninguna fila marcada kernel nombra el producto:
#   las filas kernel de la sección 2 no contienen "Intrale".
grep -nE '\| kernel \|' docs/pipeline/contrato-kernel-adaptador.md | grep -i "intrale"   # esperado: 0 resultados

# CA-4 — los 7 puertos mínimos presentes
grep -nE '`(build|test|e2e|package|deploy|discoverWork|gates)`' docs/pipeline/contrato-kernel-adaptador.md

# CA-2 — cobertura: cada bloque del inventario tiene su sub-tabla en la sección 2
grep -nE '^### 2\.' docs/pipeline/contrato-kernel-adaptador.md
```

**DoD (checklist final del PO, se valida en aprobación):**

- [ ] Documento de contrato en `docs/` revisado y aprobado.
- [ ] Frontera completa contra el inventario de #4009 (sin ítems huérfanos).
- [ ] Los 6 requisitos de security reflejados (CA-9..CA-14) y propagados a las sub-issues de Ola 9.
- [ ] Decisión de aislamiento multi-tenant anclada con recomendación (Modelo B).
- [ ] Campo de versión del contrato y política de mismatch definidos (CA-14).
