# Pipeline V2 — Diseño del Nuevo Modelo Operativo

> Documento de diseño en progreso. Resultado de sesión de ideación Leito + Claudio, 2026-03-25.

## Motivación

El pipeline actual creció orgánicamente y llegó a un punto donde:

- Hay 4 loops de control anidados (micro/meso/macro/watchdog) que se vigilan mutuamente
- 20+ archivos de estado mutuamente dependientes
- 120+ hooks JS que se disparan en cada tool use
- 3 procesos de monitoreo (coordinator + watcher + monitor) con 4100+ líneas que forman un loop circular
- De 29 skills, solo 4 escriben código — el resto es validación, planificación o infraestructura
- 10 solapamientos detectados entre skills y entre hooks/skills
- El modelo batch (agente vive, muere, se promueve el siguiente) no escala

## Principios del nuevo modelo

1. **Orientado a eventos**: los agentes reaccionan a trabajo disponible, no son lanzados por un orquestador
2. **Agentes persistentes**: cada agente es una terminal de Windows con una instancia de Claude que vive permanentemente
3. **Sin orquestador central**: el filesystem ES el estado — carpetas y archivos reemplazan coordinators, watchers y monitors
4. **Flujo continuo (Kanban)**: no hay sprints — el trabajo entra, fluye por fases, y sale
5. **Cero dependencias intra-fase**: dentro de una fase, los agentes trabajan en paralelo sin depender unos de otros
6. **Capacidad = terminales abiertas**: el WIP limit no es un número artificial sino la cantidad de agentes vivos por rol

## Arquitectura: Fases como carpetas, trabajo como archivos

### La estructura de carpetas

Cada pipeline tiene carpetas por fase. Cada fase tiene cuatro subcarpetas:

```
pendiente/     ← trabajo por hacer
trabajando/    ← un agente lo tomó
listo/         ← terminado, esperando evaluación del barrendero
procesado/     ← el barrendero ya promovió a la fase siguiente
```

Cada unidad de trabajo es **un archivo por historia × skill**. El nombre del archivo identifica la historia y el skill: `1732.po`, `1732.ux`, etc.

### Ciclo de vida de un work item

1. **Historia entra a la fase** → se crean N archivos en `pendiente/` (uno por skill requerido)
2. **Agente busca trabajo** → lista archivos de su skill en `pendiente/` → mueve uno a `trabajando/` (el `mv` es atómico en filesystem, no hay race condition)
3. **Agente termina** → escribe resultado en el archivo → mueve a `listo/`
4. **Barrendero chequea** → si todos los archivos de esa historia están en `listo/`, evalúa resultados → crea archivos en la fase siguiente (o devuelve a dev si hay rechazo) → mueve los evaluados a `procesado/`

### Por qué archivos separados por skill

Si todos los skills escribieran en un solo archivo por historia, cuando dos terminan al mismo tiempo se pisan. Con archivos separados, cada agente toca **solo su archivo**. Cero contención.

### Por qué mover entre carpetas y no marcar status dentro del archivo

1. **Buscar trabajo es un glob**: `ls pendiente/*.po` — no hay que abrir archivos para saber qué está pending
2. **Tomar trabajo es atómico**: `mv` en filesystem es atómico — si dos agentes intentan tomar el mismo archivo, uno gana y el otro falla limpiamente

## El Barrendero

Proceso simple que conecta las fases. No es un orquestador — no toma decisiones, no lanza agentes, no monitorea salud. Solo hace:

```
Para cada fase:
  Para cada historia que tiene TODO en listo/:
    Crear los archivos de la fase siguiente en pendiente/
```

Es idempotente: si se cae y lo relanzás, hace exactamente lo mismo sin romperse. No tiene estado propio — el estado ES la estructura de carpetas.

**Cada pipeline tiene su propio barrendero** (o un barrendero único que lee la configuración de fases de cada pipeline).

## Dos Pipelines Independientes

### Pipeline de Definición

Para crear y refinar historias. Opera sobre **issues en borrador**.

```
Fase 1: ANÁLISIS         guru, security       (paralelo)
Fase 2: CRITERIOS        po, ux               (paralelo)
Fase 3: SIZING           planner              (uno solo)
         ↓
Resultado: Issue "ready" en GitHub
```

#### Fase 3 (SIZING) — Comportamiento del Planner

El planner recibe una historia que ya tiene análisis técnico y criterios de aceptación. Dimensiona: simple, medio o grande.

**Tres resultados posibles:**

1. **Simple o medio** → le asigna el tamaño y la historia sale como "ready". Flujo normal.

2. **Grande, dividir** → el planner divide la historia en 2-3 historias más chicas. Cada historia hija:
   - Se crea como issue nuevo en GitHub (referenciando la historia madre)
   - Entra al pipeline de definición en **fase 2 (criterios)**, no desde cero. El análisis técnico (guru, security) del dominio ya está hecho y aplica a las partes. Lo que sí necesita revalidación son los criterios de aceptación de cada pedazo: el PO confirma que cada parte tiene sentido como entrega independiente, el UX valida coherencia.
   - La historia original se marca como "dividida" y sale del pipeline.

3. **Rechazo en criterios de una historia dividida** → si el PO o UX rechazan una de las partes ("esta parte no tiene sentido sola"), vuelve a sizing para que el planner reintente la división de otra forma. Ciclo: criterios → sizing → criterios hasta que cuaje. Límite: 2 reintentos, después escala al usuario.

**Flujo de división:**

```
#1732 → análisis ✓ → criterios ✓ → sizing: "grande, dividir"
  → Crea #1732-A, #1732-B en GitHub
  → #1732-A entra en criterios/pendiente/ (no en análisis)
  → #1732-B entra en criterios/pendiente/
  → #1732 se marca "dividida", sale del pipeline
  → PO y UX validan cada parte
  → Sizing: "simple" y "medio" → salen como "ready"
```

**Nota:** el planner es el único agente que puede crear archivos en una fase que no es la siguiente en secuencia (genera trabajo en criterios, que está antes de sizing). Es una excepción controlada al flujo lineal.

### Pipeline de Desarrollo

Para implementar historias listas. Opera sobre **issues ready**.

```
Fase 1: VALIDACIÓN       po, ux, guru              (paralelo, Claude)
Fase 2: DESARROLLO       android/backend/web        (uno por historia, Claude)
Fase 3: BUILD            build                      (uno solo, NO Claude — script puro)
Fase 4: VERIFICACIÓN     tester, security, qa       (paralelo, Claude)
Fase 5: APROBACIÓN       review, po, ux             (paralelo, Claude)
Fase 6: ENTREGA          delivery                   (uno solo, Claude)
```

**Nota sobre fase 3 (BUILD):** el build es una fase propia porque es un **prerequisito bloqueante** para la verificación. A diferencia de Telegram o Drive (que son fire-and-forget), el tester, security y QA necesitan que el código compile para poder trabajar. Al separarlo como fase:

- No bloquea agentes Claude mientras Gradle compila (puede tardar minutos)
- Si el build falla, el barrendero devuelve la historia a desarrollo con el log del error
- El agente de build no necesita ser Claude — es un script que corre `gradlew check`
- Cuando pasa, los artefactos (APK, reportes de cobertura) quedan disponibles para la fase siguiente

### Conexión entre pipelines

Los dos pipelines se conectan a través de GitHub:

```
Pipeline Definición → issue "ready" en GitHub → Intake → Pipeline Desarrollo
```

No se hablan directamente. Cada uno tiene sus carpetas, sus fases, su barrendero.

### Intake

Proceso que mira el backlog de GitHub, filtra issues marcados como "ready" (por labels, criterios de aceptación, etc.), y los empuja a la primera fase del pipeline de desarrollo. Puede ser automático (timer) o disparado manualmente.

### Estructura de carpetas completa

```
.pipeline/
  definicion/
    analisis/
      pendiente/
      trabajando/
      listo/
    criterios/
      pendiente/
      trabajando/
      listo/
    sizing/
      pendiente/
      trabajando/
      listo/

  desarrollo/
    validacion/
      pendiente/
      trabajando/
      listo/
    dev/
      pendiente/
      trabajando/
      listo/
    verificacion/
      pendiente/
      trabajando/
      listo/
    aprobacion/
      pendiente/
      trabajando/
      listo/
    entrega/
      pendiente/
      trabajando/
      listo/
```

## Agentes como roles efímeros

Cada agente es una instancia de Claude que el Pulpo lanza cuando hay trabajo:

- Tiene un skill/rol asignado (PO, UX, backend-dev, etc.)
- Se lanza cuando hay archivos pendientes para su skill
- Procesa todo lo que tiene pendiente y muere cuando no queda nada
- Cero tokens en idle — no existe cuando no hay trabajo

Un agente puede atender ambos pipelines. Por ejemplo, un agente PO busca en:

- `definicion/criterios/pendiente/*.po` — historia nueva que necesita criterios
- `desarrollo/aprobacion/pendiente/*.po` — implementación que necesita acceptance
- `desarrollo/validacion/pendiente/*.po` — historia entrando al pipeline que necesita validación

Para el agente es transparente de qué pipeline viene. Toma un archivo, lo procesa, lo mueve a `listo/`.

## Capacidad y WIP limit natural

No hay un WIP limit artificial. La capacidad del sistema es la cantidad de terminales abiertas por rol:

- 1 terminal PO → atiende historias de a una (PO es cuello de botella si hay mucho volumen)
- 2 terminales PO → atiende dos en paralelo
- 1 terminal backend-dev → una historia de backend a la vez

Si un rol se convierte en cuello de botella constante, se abre otra terminal de ese rol. Escala horizontal natural.

## Skills: consolidación

### Skills que se eliminan (aliases o duplicados)

| Skill | Razón |
|-------|-------|
| /historia | Alias de `/doc nueva` |
| /refinar | Alias de `/doc refinar` |
| /priorizar | Alias de `/doc priorizar` |
| /checkup | Duplica `/ops` + `/cleanup` |
| /branch | Lo absorbe el proceso de lanzamiento |
| /builder | Lo absorbe `/tester` (compilar ya incluye testear) |

### Skills del pipeline (roles de agentes)

| Skill | Tipo | Pipeline donde participa |
|-------|------|--------------------------|
| guru | Investigador | Definición (análisis) + Desarrollo (validación) |
| security | Auditor | Definición (análisis) + Desarrollo (verificación) |
| po | Product Owner | Definición (criterios) + Desarrollo (validación, aprobación) |
| ux | Experiencia | Definición (criterios) + Desarrollo (validación, aprobación) |
| planner | Dimensionador | Definición (sizing) |
| android-dev | Developer | Desarrollo (dev) |
| backend-dev | Developer | Desarrollo (dev) |
| web-dev | Developer | Desarrollo (dev) |
| tester | Tester | Desarrollo (verificación) |
| qa | QA E2E | Desarrollo (verificación) |
| cua | Video + evidencia | Desarrollo (verificación) |
| review | Reviewer | Desarrollo (aprobación) |
| delivery | Release | Desarrollo (entrega) |

### Skills de operaciones (servicios transversales, fuera del pipeline)

| Skill | Propósito |
|-------|-----------|
| monitor | Dashboard y visibilidad |
| ops | Salud del entorno |
| cleanup | Higiene del workspace |
| reset | Botón de pánico |
| cost | Métricas de consumo |
| scrum | Métricas de velocidad |
| auth | Permisos |
| perf | Performance de builds |
| simplify | Refactoring oportunista |
| doc | Herramienta de creación/refinamiento de historias (pre-pipeline) |

### Utilities (herramientas sueltas, no son roles)

| Skill | Propósito |
|-------|-----------|
| claude-api | Asistente Anthropic SDK |
| keybindings-help | Configuración de shortcuts |
| update-config | Modificar settings |
| loop | (se elimina — reemplazado por agentes persistentes) |
| schedule | (se evalúa — podría ser el mecanismo del intake) |

## Lo que se elimina del pipeline actual

| Componente actual | Reemplazo V2 |
|-------------------|--------------|
| agent-coordinator.js (1300 líneas) | Barrendero (~50 líneas) |
| agent-watcher.js (1400 líneas) | No necesario — agentes viven permanentemente |
| agent-monitor.js (1479 líneas) | No necesario — sin procesos efímeros que monitorear |
| health-check.js (939 líneas) | Simplificado a un /ops periódico |
| heartbeat-manager.js | No necesario — agentes persistentes tienen su propia terminal visible |
| Start-Agente.ps1 (900 líneas) | No necesario — agentes se lanzan una vez y viven |
| Run-AgentStream.ps1 (300 líneas) | No necesario |
| agent-runner.js (450 líneas) | No necesario — el pipeline es la estructura de carpetas |
| sprint-plan.json + locks + PIDs | Carpetas pendiente/trabajando/listo |
| agent-registry.json | No necesario |
| agent-events.jsonl | No necesario — los `mv` entre carpetas SON los eventos |
| circuit-breaker.js | Se evalúa si es necesario en V2 |
| 20+ archivos de estado | Estructura de carpetas como estado |

## Manejo de rechazos

Cuando un skill da un veredicto negativo (QA rechaza, PO rechaza, etc.), el flujo es:

1. El agente que rechaza **termina su trabajo normalmente**: escribe el resultado "rechazado" con el motivo en su archivo y lo mueve a `listo/`. No hace nada distinto a cuando aprueba.

2. El barrendero, al encontrar que todos los archivos de la historia están en `listo/`, **mira los resultados**:
   - Si todos aprobaron → mueve la historia a la **fase siguiente**
   - Si alguno rechazó → devuelve la historia a **desarrollo** (siempre, porque es la única fase donde se corrige código)

3. Cuando devuelve a desarrollo, el barrendero crea el archivo en `desarrollo/dev/pendiente/` con el **contexto del rechazo**: qué skill rechazó, por qué, y qué archivos tocó el developer la primera vez.

4. El developer corrige y la historia **vuelve a pasar por todas las fases posteriores** (verificación → aprobación). No puede saltar fases porque el fix podría haber roto otra cosa.

### Destino de rechazos por fase

```
build (falla)           → vuelve a desarrollo/dev (con log del error)
verificación (rechazo)  → vuelve a desarrollo/dev
aprobación (rechazo)    → vuelve a desarrollo/dev
```

Desarrollo es siempre el destino porque es la única fase donde se modifica código.

### Configuración del barrendero por fase

Cada fase define en su configuración:

- Qué skills participan (para crear archivos en pendiente)
- Cuál es la fase siguiente si todos aprueban
- Cuál es la fase destino si alguno rechaza
- Qué skill de desarrollo corresponde a la historia (backend, android, web)

El barrendero sigue siendo tonto: no toma decisiones inteligentes, solo sigue las reglas.

## Servicios de infraestructura como roles

Telegram, Google Drive y cualquier servicio externo se modelan como **roles con su propia cola**, fuera del pipeline principal. No son fases — son servicios fire-and-forget que cualquier agente del pipeline puede usar.

### Estructura

```
.pipeline/
  servicios/
    telegram/
      pendiente/
      trabajando/
      listo/
    drive/
      pendiente/
      trabajando/
      listo/
```

### Cómo funcionan

Cualquier agente del pipeline puede **crear un pedido** dejando un archivo en la carpeta del servicio. Por ejemplo:

- El QA termina su verificación y tiene un video → deja un pedido en `servicios/drive/pendiente/`
- El delivery mergea un PR → deja un pedido en `servicios/telegram/pendiente/`

El agente del pipeline **no espera respuesta** — deja el pedido y sigue con su trabajo.

### Agentes de servicio

Cada servicio tiene su propio agente (una terminal) que:

- Mira su carpeta `pendiente/`
- Toma un pedido, lo ejecuta (envía el mensaje, sube el archivo)
- Lo mueve a `listo/`
- Si falla, lo deja en `pendiente/` y lo reintenta después

Estos agentes ni siquiera necesitan ser instancias de Claude — pueden ser scripts Node.js simples que hacen poll sobre la carpeta.

### Diferencia clave con las fases del pipeline

Las fases son **secuenciales y bloqueantes**: una historia no avanza hasta que todos los skills completen. Los servicios son **paralelos y fire-and-forget**: no bloquean nada, no forman parte del flujo de la historia.

### Beneficios

- **Desacoplamiento**: el QA no necesita saber cómo funciona Google Drive
- **Reintentos gratis**: si Drive falla, el archivo queda en `pendiente/` y se reintenta automáticamente
- **Visibilidad**: `ls pendiente/` muestra mensajes sin enviar o archivos sin subir
- **Extensible**: mañana si necesitás email, Slack, o deploy a AWS, es otra carpeta con el mismo patrón

### Estructura de carpetas completa (actualizada)

```
.pipeline/
  definicion/                    ← Pipeline de Definición
    analisis/
      pendiente/
      trabajando/
      listo/
    criterios/
      pendiente/
      trabajando/
      listo/
    sizing/
      pendiente/
      trabajando/
      listo/

  desarrollo/                    ← Pipeline de Desarrollo
    validacion/
      pendiente/
      trabajando/
      listo/
    dev/
      pendiente/
      trabajando/
      listo/
    build/
      pendiente/
      trabajando/
      listo/
    verificacion/
      pendiente/
      trabajando/
      listo/
    aprobacion/
      pendiente/
      trabajando/
      listo/
    entrega/
      pendiente/
      trabajando/
      listo/

  servicios/                     ← Servicios de infraestructura (fire-and-forget)
    telegram/
      pendiente/
      trabajando/
      listo/
    drive/
      pendiente/
      trabajando/
      listo/
```

### Tipos de agentes

| Tipo | Descripción | Ejemplos |
|------|-------------|----------|
| **Claude (inteligente)** | Instancia de Claude en terminal, toma decisiones | po, ux, review, backend-dev, qa |
| **Script (mecánico)** | Script Node.js/bash, ejecuta sin inteligencia | build, telegram, drive |

Los agentes mecánicos no consumen tokens de Claude. Son scripts que hacen poll sobre su carpeta y ejecutan un comando predefinido.

## Dashboard V2

El dashboard se simplifica radicalmente. En el modelo actual, el monitor lee 20+ archivos de estado, cruza PIDs, verifica heartbeats y reconcilia sprint-plan con agent-registry. En V2, el dashboard solo necesita hacer `ls` sobre las carpetas.

### Vista principal: Colas de trabajo

```
PIPELINE DE DESARROLLO

  Validación     ●●○  (2 en listo, 1 en pendiente)
    #1732: po ✓  ux ✓  guru ⏳
    #1800: po ⏳  ux ⏳  guru ⏳

  Desarrollo     ●○○
    #1650: backend ⚙️ trabajando

  Build          (vacía)

  Verificación   ●●○
    #1600: tester ✓  security ✓  qa ⏳

  Aprobación     (vacía)

  Entrega        (vacía)

SERVICIOS
  Telegram: 0 pendientes
  Drive: 2 pendientes
```

### Lo que cambia respecto al dashboard actual

| Dashboard V1 | Dashboard V2 |
|--------------|--------------|
| Lee 20+ archivos de estado | Hace `ls` sobre carpetas |
| Necesita cruzar PIDs, heartbeats, sessions | El filesystem ES el estado |
| Reconcilia sprint-plan vs agent-registry | No hay estado duplicado |
| Monitorea salud de agentes efímeros | Agentes persistentes son visibles en sus terminales |

### Ruta nueva necesaria

El dashboard necesita una vista de **colas de trabajo** que muestre, por cada fase de cada pipeline:
- Cuántas historias hay en pendiente / trabajando / listo
- El desglose por skill de cada historia
- Los servicios y sus colas pendientes

Todo se deriva de contar y listar archivos en carpetas. No hay estado oculto.

## Decisiones definidas

### 1. Ciclo de vida de los agentes

**Modelo: Coordinador liviano + agentes efímeros-por-trabajo**

Los agentes NO son persistentes. Se lanzan cuando hay trabajo y mueren cuando terminan.

#### Coordinador liviano (único)

Un solo script (Node.js o bash, NO Claude — cero tokens) que:

- Vive permanentemente como único proceso residente
- Hace poll cada N segundos sobre todas las carpetas `pendiente/` de todos los pipelines
- Cuando detecta archivos pendientes → verifica la concurrencia del rol → lanza el agente correspondiente
- Cuando un agente muere → sigue mirando las carpetas normalmente
- No tiene estado propio — el estado son las carpetas
- Es el reemplazo del `agent-coordinator.js` actual (1300 líneas) en ~50-100 líneas

#### Agente

- El Pulpo lo lanza cuando hay trabajo para su skill
- Procesa todo lo pendiente de su skill (no solo una tarea)
- Mientras tenga tareas pendientes, sigue vivo
- Cuando no le queda nada → muere
- Cero tokens en idle — directamente no existe cuando no hay trabajo

#### Worktrees: uno por issue

Cada issue en el pipeline de desarrollo tiene su propio worktree aislado. Esto elimina conflictos de merge entre agentes que trabajan en paralelo — cada uno modifica su copia del repo. El merge se resuelve recién en la fase de entrega.

El Pulpo crea el worktree cuando el issue entra a la fase de `dev` y lo limpia después de la entrega.

#### Concurrencia configurable

Un archivo de configuración define cuántas instancias simultáneas de cada rol se permiten. El Pulpo consulta este archivo antes de lanzar un agente.

```yaml
# .pipeline/config.yaml
concurrencia:
  # Definición — no modifican código, la consistencia viene del prompt
  po: 2
  ux: 2
  guru: 2
  security: 2
  planner: 1            # necesita ver panorama completo para dimensionar

  # Desarrollo — worktree por issue, sin conflictos de merge
  backend-dev: 3
  android-dev: 2
  web-dev: 2

  # Verificación — worktree por issue
  tester: 2
  qa: 1                 # limitado por hardware (emulador + video)
  cua: 2                # grabación de video con evidencia
  review: 2

  # Entrega — secuencial
  build: 1              # limitado por hardware (Gradle consume mucha CPU/memoria)
  delivery: 1           # merge a main debe ser secuencial
```

Si hay 3 archivos `*.guru` en `pendiente/` y la concurrencia de guru es 2, el Pulpo lanza 2 instancias de guru. La tercera tarea la toma el primero que quede libre.

Si la concurrencia de un rol es 1 y ya hay una instancia corriendo, el Pulpo no lanza otra — el agente vivo la tomará cuando termine su tarea actual (porque sigue procesando mientras tenga pendientes).

Los valores por defecto son conservadores. Si un rol se convierte en cuello de botella y el hardware lo permite, se sube el número en el config.

#### Intervalos del Pulpo

- **Poll**: cada **30 segundos**. Una historia tarda minutos en procesarse — 30s de latencia es imperceptible.
- **Timeout de tareas huérfanas**: **10 minutos**. Si un archivo lleva más de 10 minutos en `trabajando/` sin proceso asociado, el Pulpo lo devuelve a `pendiente/`.

#### Lanzamiento

Un script simple parametrizado por rol:

```bash
# lanzar-agente.sh <rol>
claude --prompt "Sos el agente <rol>. Procesá los archivos en pendiente/..."
```

#### Recuperación ante fallos

No hay auto-respawn sofisticado. Si un agente muere inesperadamente (crash, error), la tarea queda en `trabajando/`. El Pulpo detecta esto (archivo en `trabajando/` por más de 10 minutos sin proceso asociado) y lo devuelve a `pendiente/` para que otro agente lo tome.

### 2. Contenido del archivo de trabajo

**Principio: una sola fuente de verdad.**

- La fuente de verdad de la historia es **GitHub** (título, descripción, labels, criterios de aceptación)
- La fuente de verdad de los outputs por fase son los **archivos en `listo/`** de la fase correspondiente

El archivo de trabajo contiene solo metadata mínima:

```yaml
issue: 1732
fase: criterios
pipeline: definicion
```

Tres líneas. Nada más. Porque:

- **¿Quién es la historia?** → `issue: 1732` → el agente hace `gh issue view 1732`
- **¿Qué hicieron las fases anteriores?** → el agente lee los archivos en `listo/` de la fase anterior (convención de carpetas: si estás en `criterios` y necesitás el análisis, mirás `analisis/listo/1732.*`)
- **¿Qué fase y pipeline?** → para que el agente sepa dónde está parado

Los archivos en `listo/` no se borran — quedan como registro y como input para fases posteriores. No hace falta referenciarlos explícitamente porque la estructura de carpetas los hace encontrables por convención.

### 3. El Pulpo: proceso central único

**Decisión: intake, barrido y lanzamiento de agentes son un solo proceso llamado "Pulpo" (`pulpo.js`).**

Un único script residente que en cada ciclo de poll hace:

1. **Barrer**: recorre las fases de cada pipeline, detecta historias con todos los archivos en `listo/`, evalúa resultados y crea archivos en la fase siguiente (o devuelve a `dev` si hay rechazo)
2. **Lanzar**: recorre las carpetas `pendiente/`, verifica concurrencia, lanza agentes si corresponde

Razones:
- Ambos hacen poll sobre las mismas carpetas
- Son lógica simple sin estado propio — no se bloquean entre sí
- Un solo proceso = un solo punto de fallo
- El orden natural es: barrer primero (generar trabajo nuevo) → lanzar después (asignar ese trabajo)

#### Configuración unificada

```yaml
# .pipeline/config.yaml
pipelines:
  definicion:
    fases: [analisis, criterios, sizing]
    fase_rechazo: null
  desarrollo:
    fases: [validacion, dev, build, verificacion, aprobacion, entrega]
    fase_rechazo: dev

concurrencia:
  po: 2
  ux: 2
  guru: 2
  security: 2
  planner: 1
  backend-dev: 3
  android-dev: 2
  web-dev: 2
  tester: 2
  qa: 1
  cua: 2
  review: 2
  build: 1
  delivery: 1
```

#### Comandos de Telegram

Diseño completo del Commander V2 (arquitectura, comandos, historial persistente) en `docs/revision-hooks-v2.md`, sección "Decisiones de diseño: Telegram Commander V2".

Comandos core: `/status`, `/actividad`, `/intake`, `/proponer`, `/pausar`/`/reanudar`, `/costos`, `/help`, `/stop` + texto libre + fotos/audio.

#### Resiliencia

Como es un script simple sin estado, se puede wrappear con un `while true` en bash como protección básica. Si muere, el sistema simplemente se pausa — no se pierde trabajo (todo queda en las carpetas) y se retoma al relanzarlo.

### 4. Intake: automático dentro del Pulpo

**Decisión: el intake es parte del Pulpo, automático.**

El Pulpo ya hace poll cada N segundos. En ese mismo ciclo agrega un paso previo:

1. **Intake**: consulta GitHub por issues con labels de entrada → crea archivos en la primera fase del pipeline correspondiente
2. **Barrer**: mueve historias entre fases según resultados
3. **Lanzar**: asigna trabajo a agentes según concurrencia

#### Configuración

```yaml
# .pipeline/config.yaml (se suma a lo existente)
intake:
  definicion:
    label: "needs-definition"
    fase_entrada: analisis
  desarrollo:
    label: "ready"
    fase_entrada: validacion
```

El Pulpo hace `gh issue list --label "ready"` (o equivalente via API), y para cada issue que no tenga ya archivos en el pipeline, crea los archivos en `pendiente/` de la fase de entrada.

#### Deduplicación

Para no crear archivos duplicados, el Pulpo verifica que el issue no exista ya en ninguna carpeta del pipeline (pendiente, trabajando o listo de cualquier fase). Un simple `find .pipeline/ -name "1732.*"` resuelve esto.

### 5. Extensibilidad: pipelines futuros

**Decisión: no diseñar pipelines futuros ahora, pero el modelo los soporta sin cambios de código.**

Agregar un tercer pipeline (post-mortem, refactoring, deuda técnica, etc.) requiere:

1. Una entrada nueva en `config.yaml` con sus fases
2. Crear las carpetas correspondientes en `.pipeline/`
3. Definir qué label de GitHub dispara el intake

El Pulpo ya recorre todos los pipelines configurados. El barrendero ya es genérico. Los agentes ya buscan por skill sin importar el pipeline. No hay nada que cambiar en el código del Pulpo.

---

## Inventario de componentes actuales: qué se descarta y qué sobrevive

### Hooks actuales (75 archivos en `.claude/hooks/`)

#### Se ELIMINAN — reemplazados por el filesystem como estado

| Hook | Razón de eliminación |
|------|---------------------|
| `agent-coordinator.js` (1300 líneas) | Reemplazado por el Pulpo liviano (~100 líneas) |
| `agent-watcher.js` (1400 líneas) | No necesario — agentes efímeros, no hay que monitorear procesos vivos |
| `agent-monitor.js` (1479 líneas) | No necesario — el dashboard V2 hace `ls` sobre carpetas |
| `health-check.js` / `health-check-sprint.js` | No necesario — sin procesos persistentes que monitorear |
| `heartbeat-manager.js` | No necesario — agentes efímeros no envían heartbeats |
| `agent-concurrency-check.js` | Reemplazado por la config de concurrencia en `config.yaml` |
| `agent-registry.js` | No necesario — no hay registry, las carpetas `trabajando/` son el registro |
| `agent-progress.js` | No necesario — el progreso es la posición del archivo en las carpetas |
| `agent-doctor.js` | No necesario — si un agente muere, el Pulpo devuelve la tarea a `pendiente/` |
| `agent-retry-diagnostics.js` | No necesario — sin reintentos complejos |
| `circuit-breaker.js` | No necesario — sin loops de control que cortocircuitar |
| `process-supervisor.js` | No necesario — sin procesos persistentes que supervisar |
| `sprint-manager.js` / `sprint-sync.js` / `sprint-data.js` | No necesario — sin sprints, flujo continuo |
| `scrum-monitor-bg.js` / `scrum-auto-corrections.js` / `scrum-consistency-check.js` / `scrum-validator.js` | No necesario — sin sprints |
| `auto-repair-sprint.js` | No necesario — sin sprints |
| `roadmap-planner.js` / `roadmap-registry-check.js` | No necesario — sin sprints ni roadmap.json |
| `pre-launch-validation.js` | No necesario — el Pulpo valida antes de lanzar |
| `system-health.js` | No necesario — sin procesos persistentes que monitorear |
| `session-gc.js` | No necesario — sin sesiones persistentes que limpiar |
| `log-rotation.js` | No necesario — agentes efímeros no acumulan logs |

#### Se ELIMINAN — funcionalidad absorbida por el pipeline de carpetas

| Hook | Razón de eliminación |
|------|---------------------|
| `delivery-gate.js` / `delivery-report.js` | El gate es la fase de entrega del pipeline |
| `post-merge-qa.js` | El gate de QA es la fase de verificación del pipeline |
| `auto-review-bg.js` | El review es una fase del pipeline |
| `ci-auto-repair.js` / `ci-monitor-bg.js` | El build es una fase del pipeline |
| `post-tool-orchestrator.js` | No necesario — sin orquestación de hooks |
| `activity-logger.js` | Los `mv` entre carpetas son los eventos — log adicional es redundante |
| `ops-learnings.js` | Si `/ops` necesita aprendizajes, los lee del filesystem |

#### SOBREVIVEN — funcionalidad independiente del pipeline

| Hook | Razón |
|------|-------|
| `telegram-commander.js` | Sigue siendo la interfaz de comandos remotos |
| `telegram-client.js` | Librería para enviar mensajes |
| `telegram-sanitizer.js` | Utilidad de sanitización |
| `telegram-image-utils.js` | Utilidad de imágenes |
| `notify-telegram.js` | Lo usa el servicio de Telegram del pipeline |
| `stop-notify.js` | Notificación cuando un agente termina |
| `commander-launcher.js` | Lanza el Telegram Commander |
| `branch-guard.js` | Protección de ramas — sigue siendo útil independientemente |
| `worktree-guard.js` | Protección de worktrees — sigue siendo útil |
| `permission-*.js` (5 archivos) | Sistema de permisos — independiente del pipeline |
| `api-keys-guardian.js` | Protección de secrets — independiente del pipeline |
| `context-reader.js` | Utilidad de lectura de contexto |
| `atomic-write.js` | Utilidad de escritura atómica |
| `validation-utils.js` / `project-utils.js` | Utilidades compartidas |

#### Se ELIMINAN — evaluados y descartados

| Hook | Razón |
|------|-------|
| `approval-history.js` | Los archivos en `listo/` ya son el historial |
| `pending-questions.js` | Mecanismo del modelo actual, no aplica en V2 |
| `send-proposal-buttons.js` | Acoplado al flujo de sprints |
| `telegram-message-registry.js` | Innecesario — el servicio de Telegram es fire-and-forget |
| `telegram-response-summarizer.js` | Over-engineering para mensajes simples |
| `telegram-last-full-response.js` | Idem |
| `telegram-cleanup.js` | Sin registry ni historial complejo, no hay qué limpiar |
| `post-console-response.js` | Hook del modelo actual, los agentes V2 no lo necesitan |
| `post-git-push.js` / `post-issue-close.js` | La notificación la hace el agente dejando pedido en `servicios/telegram/` |
| `add-to-project-status.js` / `fix-project-status.js` | GitHub Projects se maneja directo con `gh` |

#### Se RECICLA — base para servicio V2

| Hook | Destino |
|------|---------|
| `telegram-outbox.js` | Se recicla como base del servicio de Telegram del pipeline (`servicios/telegram/`) |

### Scripts actuales (`scripts/`)

#### Se ELIMINAN

| Script | Razón de eliminación |
|--------|---------------------|
| `Start-Agente.ps1` (900 líneas) | Reemplazado por el Pulpo liviano |
| `Stop-Agente.ps1` | No necesario — agentes mueren solos |
| `Run-AgentStream.ps1` | No necesario — sin stream parsing |
| `Watch-Agentes.ps1` | No necesario — sin watchers |
| `Guardian-Sprint.ps1` | No necesario — sin sprints |
| `auto-plan-sprint.js` | No necesario — sin sprints |
| `ask-next-sprint.js` | No necesario — sin sprints |
| `sprint-*.js` (8+ archivos) | No necesario — sin sprints |
| `restart-operational-system.js` | Reemplazado por `/pipeline start` de Telegram |
| `reset-operations.js` | Simplificado — solo relanzar el Pulpo |
| `planner-propose-interactive.js` | El planner V2 trabaja sobre archivos en carpetas |

#### SOBREVIVEN

| Script | Razón |
|--------|-------|
| `dev-functions.sh` | Funciones dev-* del shell — independientes |
| `local-up.sh` / `local-down.sh` / `local-app.sh` | Entorno local de desarrollo |
| `init-local-aws.sh` | Setup DynamoDB local |
| `smart-build.sh` | Podría ser el agente mecánico de build |
| `send-telegram-doc.js` / `send-telegram-video.js` / `send-report-telegram.js` | Utilidades de Telegram |
| `report-to-pdf-telegram.js` | Generación de reportes |
| `cleanup-worktrees.js` | Limpieza de worktrees (sigue habiendo worktrees por agente) |
| `validate-env.sh` | Validación de entorno |
| `collect-api-usage.js` / `cost-report.js` | Métricas de costo — independientes |

### Archivos de estado que se ELIMINAN

Todos los archivos JSON de estado en `.claude/hooks/` son reemplazados por la estructura de carpetas:

| Archivo | Reemplazo |
|---------|-----------|
| `agent-registry.json` | Carpetas `trabajando/` |
| `agent-metrics.json` | Conteo de archivos por carpeta |
| `agent-progress-state.json` | Posición del archivo en las carpetas |
| `agent-events.jsonl` | Los `mv` entre carpetas son los eventos |
| `health-check-state.json` / `health-check-*.json` | No necesario |
| `heartbeat-state.json` | No necesario |
| `scrum-monitor-state.json` / `scrum-health-history.jsonl` | No necesario — sin sprints |
| `circuit-breaker-state.json` | No necesario |
| `process-registry.json` | No necesario |
| `auto-review-state.json` | No necesario |
| `sessions-history.jsonl` | No necesario — sin sesiones persistentes |

### Resumen cuantitativo

| Categoría | Actual | V2 |
|-----------|--------|-----|
| Hooks JS | 75 | ~15-20 (Telegram + permisos + guards + utilidades) |
| Scripts | 50+ | ~15 (utilidades + entorno local) |
| Archivos de estado JSON | 20+ | 0 (el filesystem es el estado) |
| Procesos residentes | 3-4 (coordinator + watcher + monitor + commander) | 1 (Pulpo) + Listener Telegram |
| Líneas de infra | 5000+ | ~100-200 (Pulpo) |

## Estrategia de implementación

**Fecha objetivo: viernes 2026-03-27** (renovación de cuota API Anthropic).

La migración se ejecuta en one-shot: arrancar y terminar de corrido. Quedarse a mitad dejaría el sistema roto (viejo a medio borrar, nuevo sin funcionar).

### Paso 1: Backup (5 min)

```bash
git tag v1-pipeline-backup -m "Backup completo del pipeline V1 antes de migración a V2"
git push origin v1-pipeline-backup
```

Opcional: copiar `.claude/hooks/` a `_backup/hooks-v1/` por si se quiere consultar sin hacer checkout del tag.

### Paso 2: Purga (10 min)

Eliminar en este orden:

1. **Archivos de estado JSON** (~20 archivos en `.claude/hooks/`) — son los que menos riesgo tienen, no son código
2. **Hooks descartados** (~55 archivos) — los listados en las tablas "Se ELIMINAN" de este documento
3. **Scripts descartados** (~35 archivos) — idem

Verificar que solo quedan los hooks y scripts marcados como "SOBREVIVEN" + el reciclado (`telegram-outbox.js`).

### Paso 3: Crear estructura de carpetas (5 min)

```bash
mkdir -p .pipeline/definicion/{analisis,criterios,sizing}/{pendiente,trabajando,listo}
mkdir -p .pipeline/desarrollo/{validacion,dev,build,verificacion,aprobacion,entrega}/{pendiente,trabajando,listo}
mkdir -p .pipeline/servicios/{telegram,drive}/{pendiente,trabajando,listo}
```

Crear `.pipeline/config.yaml` con la configuración definida (pipelines + concurrencia + intake).

### Paso 4: Coordinador liviano (1-2 horas)

Escribir `.pipeline/pulpo.js` (~100-200 líneas) con el ciclo:

1. **Intake**: `gh issue list --label "ready"` / `--label "needs-definition"` → crear archivos en `pendiente/`
2. **Barrido**: recorrer fases, detectar historias completas en `listo/`, mover a fase siguiente o devolver a `dev`
3. **Lanzamiento**: recorrer `pendiente/`, verificar concurrencia, lanzar agentes
4. **Huérfanos**: detectar archivos en `trabajando/` por más de 10 min sin proceso → devolver a `pendiente/`
5. **Sleep 30s** → volver a 1

### Paso 5: Script de lanzamiento de agentes (30 min)

Escribir `lanzar-agente.sh` parametrizado por rol. Incluye:
- Creación de worktree para el issue (si es fase de dev)
- Invocación de Claude con el prompt del rol
- Limpieza del worktree al terminar

### Paso 6: Telegram Commander — comandos de pipeline (30 min)

Agregar a `telegram-commander.js`:
- `/pipeline status` — estado del Pulpo + resumen de colas
- `/pipeline start` — levantar el Pulpo si está caído

### Paso 7: Actualizar prompts de skills (1-2 horas)

Reescribir los prompts de los ~15 roles del pipeline para que entiendan:
- Buscar trabajo en `pendiente/` de su skill
- Mover a `trabajando/` al empezar
- Escribir resultado en el archivo
- Mover a `listo/` al terminar
- Leer contexto de fases anteriores en `listo/` de la fase previa
- Leer info del issue desde GitHub

### Paso 8: Validación (30 min)

- Verificar que el Pulpo arranca y hace poll
- Crear un issue de prueba con label "needs-definition"
- Verificar que el intake lo detecta y crea archivos
- Verificar que un agente se lanza, procesa y muere
- Verificar que el barrendero mueve la historia a la fase siguiente
- Verificar `/pipeline status` desde Telegram

### Resumen de esfuerzo

| Paso | Esfuerzo |
|------|----------|
| Backup | Trivial |
| Purga | Trivial |
| Estructura de carpetas | Trivial |
| Coordinador | Medio |
| Script de lanzamiento | Simple |
| Telegram Commander | Simple |
| Actualizar prompts | Medio |
| Validación | Simple |

**Esfuerzo total: medio.** La mayor parte del trabajo es el Pulpo y los prompts. El resto es mecánico.

## Diagramas

- Pipeline actual (fases × skills × hooks): `docs/pipeline-actual.html`
- Pipeline V2: pendiente de crear

---

*Documento vivo — se actualiza a medida que avanza el diseño.*
