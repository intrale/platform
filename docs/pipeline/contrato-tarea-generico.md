# Contrato de tarea genérico (Ola Puente · H1 · #4717)

> **Historia:** #4717 — Definir el contrato de tarea genérico · size:M
> **Parent:** #4716 (Abstracción de tareas genéricas) · **Épico:** #4644 (Ola Puente — Kernel multi-producto)
> **Naturaleza:** documento de **diseño del modelo operativo** (no implementación). Define la
> estructura mínima del contrato que separa *"qué significa que una tarea está lista y qué lo
> prueba"* de *"quién la ejecuta y qué entregable produce"*. Esta historia **define**; la
> implementación del ejecutor genérico es **H2 (#4718)** y el wiring de fases es **H3 (#4719)**.
> **Estado:** documento vivo — se revisa al entrar a H2/H3.
>
> **Versión del contrato:** `0.1.0` (semver). Historial: ver [Changelog](#changelog).
>
> **Documentos hermanos (relacionados, NO duplicados por este):**
> - [`contrato-kernel-adaptador.md`](contrato-kernel-adaptador.md) — separa **kernel operativo**
>   de **adaptador de producto** (qué vive de cada lado). Este #4717 es **ortogonal**: define el
>   contrato de **una tarea individual**, no la frontera kernel↔producto. Un contrato de tarea es
>   un dato que fluye *dentro* del kernel; el adaptador aporta los *ejecutores* concretos.
> - [`entregables-multimedia-por-agente.md`](entregables-multimedia-por-agente.md) — catálogo de
>   qué artefacto multimedia deja cada skill y dónde. Este doc **reutiliza su vocabulario** de
>   "tipo entregable" y "evidencia" para no divergir.
> - Modelo fase→agente→entregable del épico **#4255** — este contrato es la generalización de ese
>   modelo: el `ejecutor` reemplaza el "agente" cableado y el `tipo_entregable` generaliza el
>   "entregable" hoy implícito.

---

## Cómo leer este documento

Hoy el pipeline asume, **cableado**, que toda tarea produce un *diff de código*. La fase `dev`
significa literalmente: *"creá una rama `agent/<issue>-<slug>` → commiteá un diff → build → QA con
video → delivery con PR"*. Ese supuesto está incrustado en el lifecycle: el intake busca una rama,
el build corre `gradlew`, el QA graba un emulador, el delivery abre un PR. **Funciona para el ~95 %
de las tareas** porque casi todas producen código.

El problema aparece cuando el entregable **no es un diff**. El caso **#4700** (§[6](#6-caso-de-validación-4700)) lo
destapó en vivo: su entregable real era *correr un ciclo self-hosting completo (dev→build→QA→delivery)
contra el repo del kernel*, y **por diseño nunca iba a generar una rama con commits en `platform`**.
El pipeline quedó sin forma de representar la tarea → limbo: ni entra por intake (la ve ocupada), ni
avanza (no hay rama que validar).

Diagnóstico de fondo (de #4716): **confundimos "tarea" con "código"**. Los roles `backend-dev`,
`android-dev`, `web-dev`, `pipeline-dev` no son *"el rol"*: son **ejecutores especializados en un
tipo de entregable — código**. Falta el nivel genérico por encima.

Este documento define ese nivel: un **contrato de tarea** con cuatro campos mínimos
(§[1](#1-estructura-del-contrato-campos-mínimos)) que las fases **leen** en vez de **asumir**
(§[3](#3-cómo-las-fases-consumen-el-contrato)). El entregable "código" queda expresado como **un
caso particular** del contrato (§[4](#4-el-entregable-código-como-caso-particular-retrocompatibilidad)),
de modo que para las tareas de código **nada cambia**.

Mapeo sección ↔ criterios de aceptación (CA de #4717):

| Sección de este documento | CA cubierto |
|---------------------------|-------------|
| 1. Estructura del contrato (campos mínimos) | CA-1 |
| 2. Semántica de cada campo | CA-1 |
| 3. Cómo las fases consumen el contrato | CA-1 |
| 4. El entregable "código" como caso particular | CA-2 |
| 5. El campo `ejecutor` y el catálogo de tipos | CA-1 |
| 6. Caso de validación: #4700 | CA-3 |

**Fuera de alcance (qué NO define este documento):**

- Implementación del ejecutor genérico (eso es **H2 #4718**).
- Wiring concreto de las fases para leer el contrato — parsers, esquemas de config, cambios en el
  Pulpo (eso es **H3 #4719**).
- Alta o baja de fases del pipeline. La cadena
  (definición → dev → build → verificación → linteo → aprobación → entrega) **no se toca**;
  sólo cambia *qué significa* cada fase cuando lee el contrato.

---

## 1. Estructura del contrato (campos mínimos)

<!-- CA-1 -->

Un **contrato de tarea** es una descripción declarativa que responde a dos preguntas
independientes:

1. **¿Cuándo está lista la tarea y qué lo prueba?** → campos `definicion_de_listo` +
   `evidencia_requerida`.
2. **¿Quién la ejecuta y qué produce?** → campos `tipo_entregable` + `ejecutor`.

La separación es deliberada: el *"qué prueba listo"* pertenece al **contrato** (lo define la fase de
definición, es estable), mientras que el *"quién ejecuta"* pertenece al **ejecutor** (es
intercambiable). El mismo `definicion_de_listo` puede resolverse con distintos ejecutores.

Estructura mínima (los cuatro campos son **obligatorios**):

```yaml
# Contrato de tarea (v0.1.0) — se adjunta al issue / ítem de trabajo
contrato_tarea:
  version: "0.1.0"                 # semver del esquema del contrato
  tipo_entregable: codigo          # codigo | recurso_provisionado | despliegue | documento | verificacion_externa | ...
  definicion_de_listo:             # condición verificable de aceptación (qué debe ser cierto al terminar)
    - "El endpoint responde 200 con el payload esperado"
    - "Los tests del módulo pasan"
  evidencia_requerida:             # qué prueba OBJETIVAMENTE el "listo" (artefacto observable por una fase)
    tipo: pr_mas_build             # pr_mas_build | describe_table_round_trip | health_check | doc_publicado | log_de_ciclo | ...
    detalle: "PR abierto + build verde en CI"
  ejecutor:                        # qué TIPO de ejecutor realiza la tarea
    tipo: dev_codigo               # dev_codigo | provisioner_infra | deployer | doc_writer | runner_externo | ...
    skill: backend-dev             # skill/rol concreto que instancia ese tipo (opcional; el kernel puede resolverlo por labels)
```

> **Retrocompatibilidad:** cuando el contrato está **ausente**, el kernel asume el contrato por
> defecto `codigo` (§[4](#4-el-entregable-código-como-caso-particular-retrocompatibilidad)). Ningún
> issue existente necesita declararlo para seguir funcionando igual que hoy.

Los cuatro campos y su relación:

```
                ┌───────────────── CONTRATO (estable, lo fija la definición) ──────────────┐
                │                                                                           │
  tipo_entregable ──describe qué se produce──►  definicion_de_listo ──se prueba con──► evidencia_requerida
                │                                                                           │
                └──────────────────── lo realiza ──────────────────────────────────────────┘
                                          │
                                          ▼
                                      ejecutor  (intercambiable; el adaptador aporta la implementación)
```

---

## 2. Semántica de cada campo

<!-- CA-1 -->

### 2.1 `tipo_entregable`

**Qué es.** La categoría de artefacto que la tarea produce para el operador/sistema. Generaliza la
columna *"Tipo entregable"* de [`entregables-multimedia-por-agente.md`](entregables-multimedia-por-agente.md)
(§0), elevándola de "artefacto multimedia" a "artefacto de cualquier naturaleza".

**Valores iniciales** (catálogo abierto — se extiende sin romper el contrato):

| Valor | Significado | Ejemplo |
|-------|-------------|---------|
| `codigo` | Un diff versionado en un repo. **Default histórico.** | Nuevo endpoint Ktor, pantalla Compose. |
| `recurso_provisionado` | Un recurso de infra que **existe y responde** tras la tarea. | Tabla DynamoDB, cola SQS, bucket S3. |
| `despliegue` | Un artefacto **desplegado** a un entorno que corre. | JAR en Lambda, APK publicado. |
| `documento` | Un documento de diseño/análisis/runbook. | Este mismo `.md`, un ADR, un análisis de guru. |
| `verificacion_externa` | La **ejecución** de un proceso contra un target externo, cuya salida es la evidencia (no hay diff local). | El ciclo self-hosting de #4700. |

**Cómo se determina.** Lo fija la fase de **definición** (guru/po/architect) al describir la tarea.
Es el campo que **desambigua** qué significan las fases posteriores para *esta* tarea.

**Regla de coherencia (anti-divergencia).** Los valores deben mantenerse alineados con el vocabulario
de #4255 (fase→agente→entregable) y con la columna "Tipo entregable" de multimedia. Un valor nuevo se
agrega a la tabla de arriba **antes** de usarse, para evitar sinónimos divergentes.

### 2.2 `definicion_de_listo`

**Qué es.** La **condición verificable de aceptación**: qué debe ser cierto en el mundo cuando la
tarea termina. Es una lista de aserciones en lenguaje observable, **no** una descripción de esfuerzo.

**Propiedad clave: verificabilidad.** Cada ítem debe poder chequearse empíricamente por una fase
posterior sin juicio subjetivo. Malo: *"el endpoint funciona bien"*. Bien: *"`GET /health` responde
200 en < 500 ms"*. Es el análogo genérico de los *criterios de aceptación* de un issue de código,
pero expresado de forma que **cualquier** tipo de entregable pueda tenerlo (una tabla que existe, un
documento que cubre N secciones, un ciclo que avanzó por todas las fases).

**Relación con `tipo_entregable`.** El tipo condiciona qué forma toma "listo":
- `codigo` → los criterios de aceptación del issue + tests verdes.
- `recurso_provisionado` → el recurso existe con el schema/config pedido y responde.
- `documento` → el doc existe en la ruta esperada y cubre los CA de la historia.
- `verificacion_externa` → el proceso corrió end-to-end con la salida esperada.

### 2.3 `evidencia_requerida`

**Qué es.** El **artefacto observable** que prueba objetivamente que `definicion_de_listo` se cumple.
Es la diferencia entre *afirmar* "está listo" y *demostrarlo*. Cada fase de verificación consume esta
evidencia en vez de asumir "hay un diff + video QA".

Generaliza el *"QA con video"* actual: el video E2E es **una** forma de evidencia (la del entregable
código con UI), no la única.

| `tipo_entregable` | `evidencia_requerida.tipo` típico | Qué se observa |
|-------------------|-----------------------------------|----------------|
| `codigo` | `pr_mas_build` (+ `video_qa` si hay UI) | PR abierto + build verde (+ video E2E). |
| `recurso_provisionado` | `describe_table_round_trip` | `describe-table` con el schema + smoke test round-trip (escribo → leo → borro un ítem). |
| `despliegue` | `health_check` | El servicio desplegado responde en el entorno destino. |
| `documento` | `doc_publicado` | El archivo existe en la ruta, cubre los CA, pasa revisión. |
| `verificacion_externa` | `log_de_ciclo` | Logs/artefactos que muestran el avance por cada fase + target verificado. |

**Propiedad clave: objetividad.** La evidencia debe ser un **artefacto** (archivo, output de comando,
respuesta HTTP), no un veredicto. Una fase de verificación la mira y decide `aprobado`/`rechazado`
comparándola contra `definicion_de_listo`.

### 2.4 `ejecutor`

**Qué es.** El **tipo de ejecutor** que realiza la tarea. Es el nivel genérico que faltaba: hoy el
rol (`backend-dev`, etc.) está cableado a "producí código". El contrato lo declara explícito y lo
hace intercambiable. Detalle del catálogo de tipos en §[5](#5-el-campo-ejecutor-y-el-catálogo-de-tipos).

**Cómo se resuelve.** El kernel mapea `ejecutor.tipo` → skill/rol concreto. Si `ejecutor.skill` está
presente, se usa directo; si no, el kernel lo resuelve por labels del issue (como hoy `dev` elige
entre `backend-dev`/`android-dev`/`web-dev`/`pipeline-dev` según `area:*`/`app:*`).

**Separación contrato ↔ ejecutor.** El `definicion_de_listo` y la `evidencia_requerida` **no
dependen** del ejecutor elegido: "la tabla existe y responde" se prueba igual sin importar si la
provisiona un script Terraform o el AWS SDK. Esto permite cambiar de ejecutor sin reescribir el
contrato — el punto exacto que la implementación (H2 #4718) explota.

---

## 3. Cómo las fases consumen el contrato

<!-- CA-1 — a alto nivel; el wiring detallado es H3 #4719 -->

La cadena de fases **no cambia** (config actual: `validacion → dev → build → verificacion → linteo →
aprobacion → entrega`). Lo que cambia es que cada fase pasa de **asumir "código"** a **leer el
contrato** y actuar según `tipo_entregable` / `evidencia_requerida`. A alto nivel:

| Fase | Hoy (asume código) | Con contrato (lee `tipo_entregable`) |
|------|--------------------|--------------------------------------|
| **validacion** | po/ux/guru validan alcance de un cambio de código | Validan el **contrato**: ¿`definicion_de_listo` es verificable? ¿`evidencia_requerida` la prueba? |
| **dev** | Crea rama, commitea diff | Invoca al `ejecutor` del contrato. Para `codigo` → idéntico a hoy. Para otros tipos → el ejecutor produce su entregable (recurso, despliegue, doc, ejecución). |
| **build** | `gradlew check` | Sólo aplica si el entregable **compila** (`codigo`/`despliegue`). Para `recurso_provisionado`/`documento` la fase es **no-op declarada** (pasa sin acción, no se saltea silenciosamente). |
| **verificacion** | tester/security/qa con video | Consume `evidencia_requerida`: video E2E para `codigo` con UI; `describe_table_round_trip` para infra; revisión de doc para `documento`; `log_de_ciclo` para `verificacion_externa`. |
| **linteo** | chequeos mecánicos sobre el diff | Aplica al artefacto que corresponda; no-op declarada si no hay diff. |
| **aprobacion** | review/po/architect sobre el PR | Verifica `definicion_de_listo` contra la `evidencia_requerida`, sea cual sea el tipo. |
| **entrega** | delivery abre PR / mergea | Para `codigo` → PR como hoy. Para otros tipos → el ejecutor cierra su entregable (encola provisión, registra despliegue, publica doc) sin exigir un PR de `platform`. |

**Principio rector (no big-bang, de #4716):** la fase que no aplica a un `tipo_entregable` **declara
un no-op explícito** (queda registrado que "esta fase no corresponde a este contrato"), en vez de
saltearse en silencio. Así el lifecycle sigue siendo trazable y auditable, y no aparece el limbo de
#4700 (ni "ocupada sin rama" ni "sin rama que validar"). El detalle mecánico de cómo cada fase lee y
resuelve el contrato es **H3 (#4719)**.

---

## 4. El entregable "código" como caso particular (retrocompatibilidad)

<!-- CA-2 — retrocompatibilidad total -->

El comportamiento actual del pipeline es **exactamente** el contrato con `tipo_entregable: codigo`.
Se expresa así:

```yaml
contrato_tarea:
  version: "0.1.0"
  tipo_entregable: codigo
  definicion_de_listo:
    - "Los criterios de aceptación del issue se cumplen"
    - "Los tests nuevos/afectados pasan"
  evidencia_requerida:
    tipo: pr_mas_build            # + video_qa cuando el issue toca UI (app:client/business/delivery)
    detalle: "Rama agent/<issue>-<slug> con commits, PR con Closes #<n>, build verde, QA con video si hay UI"
  ejecutor:
    tipo: dev_codigo
    skill: backend-dev            # o android-dev / web-dev / pipeline-dev, resuelto por labels
```

**Garantías de retrocompatibilidad total:**

1. **Contrato ausente ⇒ default `codigo`.** El kernel trata *"sin contrato declarado"* como el
   contrato de arriba. Ningún issue existente necesita cambios. El ~95 % de las tareas que producen
   código no ve **ninguna** diferencia.
2. **El lifecycle no cambia para `codigo`.** Rama → diff → build → QA con video → PR sigue siendo la
   ejecución literal. Las fases que "leen el contrato" resuelven, para `codigo`, exactamente lo que
   hacían cableado.
3. **Gate de QA intacto.** Los labels `qa:passed` / `qa:skipped` (CLAUDE.md) siguen siendo la
   `evidencia_requerida` del tipo `codigo` con UI. El contrato **no relaja** ningún gate: lo
   generaliza (para `codigo` con UI, la evidencia sigue siendo video E2E).
4. **Roles = ejecutores de tipo `dev_codigo`.** `backend-dev`, `android-dev`, `web-dev`,
   `pipeline-dev` no se renombran ni se tocan; simplemente **encajan** como instancias del tipo de
   ejecutor `dev_codigo`. Visto desde el contrato, son un ejecutor más.

En una frase: **el modelo genérico es una superset del actual; el actual es la instancia `codigo`.**

---

## 5. El campo `ejecutor` y el catálogo de tipos

<!-- CA-1 -->

El `ejecutor` es el punto de extensión que convierte "rol de código" en "un tipo de ejecutor entre
varios". Catálogo inicial (abierto):

| `ejecutor.tipo` | Produce (`tipo_entregable`) | Skills/roles que lo instancian | Estado |
|-----------------|-----------------------------|--------------------------------|--------|
| `dev_codigo` | `codigo` | `backend-dev`, `android-dev`, `web-dev`, `pipeline-dev` | **Existe hoy** (cableado). |
| `provisioner_infra` | `recurso_provisionado` | (nuevo, H2 #4718 — caso base de datos) | Diseñado en #4716 §4; implementa H2. |
| `deployer` | `despliegue` | `delivery` (parcial, Lambda) | Parcial hoy. |
| `doc_writer` | `documento` | `guru`, `po`, `planner`, `architect` | Existe (produce docs), sin contrato explícito. |
| `runner_externo` | `verificacion_externa` | (nuevo — caso #4700) | Sin ejecutor formal; hoy cae en limbo. |

**Relación ejecutor ↔ adaptador.** Quién *implementa* concretamente cada tipo de ejecutor es
responsabilidad del **adaptador de producto** ([`contrato-kernel-adaptador.md`](contrato-kernel-adaptador.md)):
el kernel define el *puerto* "ejecutor de tipo X"; el adaptador aporta el *adapter* concreto
(`backend-dev` sabe de Ktor, un `provisioner_infra` sabría de AWS SDK). El contrato de tarea es el
dato que el kernel pasa al ejecutor; el adaptador decide cómo lo satisface. Este doc **no** re-define
esa frontera — la referencia.

---

## 6. Caso de validación: #4700

<!-- CA-3 — se referencia #4700 como caso que el contrato debe poder representar -->

**#4700** ("Demo verificable dev→build→QA→delivery sobre `intrale/kernel`") es el caso que **el
contrato debe poder representar** y que hoy queda en limbo. Su entregable **no es un diff en
`platform`**: es la **ejecución** de un ciclo self-hosting completo contra un target controlado del
kernel (los fixtures `agent/4699-fixtures`), con evidencia de avance por cada fase.

Expresado como contrato de tarea:

```yaml
contrato_tarea:
  version: "0.1.0"
  tipo_entregable: verificacion_externa      # NO 'codigo' — no genera rama en platform
  definicion_de_listo:
    - "Se demuestra un ciclo dev→build→QA→delivery completo apuntando al target controlado del kernel"   # CA-D2.1
    - "Antes de cada fase mutante se verifica el remote/target (nunca intrale/platform)"                  # CA-D2.2
    - "delivery corre sin auto-merge y sin mergear/firmar a main"                                         # CA-D2.3
    - "El bootstrap corre contra versión del kernel pineada y verificada (npm ci + lockfile con hashes)"  # CA-D2.4
  evidencia_requerida:
    tipo: log_de_ciclo
    detalle: >-
      Logs/artefactos que muestran el avance por cada fase del ciclo + output que muestra el
      target verificado en cada fase mutante (ej. '✔ target = kernel-fixtures (verificado)').
  ejecutor:
    tipo: runner_externo
    skill: null                                # resuelto por H2/H3; hoy NO existe → por eso caía en limbo
```

**Qué demuestra este mapeo (por qué el contrato resuelve el limbo de #4700):**

- El `tipo_entregable: verificacion_externa` le dice al pipeline que **no debe buscar una rama en
  `platform`** — elimina la causa raíz del limbo ("ocupada sin rama" / "sin rama que validar").
- La `definicion_de_listo` captura los CA reales de #4700 (incluidos los de seguridad de blast
  radius) como aserciones verificables, sin asumir "hay un diff".
- La `evidencia_requerida: log_de_ciclo` reemplaza al "PR + build + video QA" por la evidencia que
  #4700 **sí** produce: logs de avance y verificación de target por fase.
- El `ejecutor: runner_externo` nombra el tipo de ejecutor que **hoy no existe** — exactamente el gap
  que motivó esta Ola Puente. Su implementación es H2 (#4718)/H3 (#4719); este doc sólo demuestra que
  el contrato **puede representarlo**.

> **Nota:** #4700 quedó acotado por split a la prueba contra un target controlado (la prueba real
> contra `intrale/kernel@main` publicado es #4706). El contrato representa **ambas** variantes con el
> mismo esquema: sólo cambia el `detalle` del target dentro de `evidencia_requerida` / la
> `definicion_de_listo`.

---

## Changelog

| Versión | Fecha | Cambio |
|---------|-------|--------|
| `0.1.0` | 2026-07-15 | Versión inicial (#4717). Define los 4 campos mínimos (`tipo_entregable`, `definicion_de_listo`, `evidencia_requerida`, `ejecutor`), su semántica, cómo las fases los consumen a alto nivel, el entregable `codigo` como caso particular (retrocompat total) y el mapeo de #4700 como caso representable. |
