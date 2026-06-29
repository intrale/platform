# Wizard de setup inicial — generador del adaptador

> **Épica:** EP-OLA8-E · Wizard de setup inicial (issue #4013)
> **Ola:** 8 — Definición del desacople kernel operativo ↔ producto
> **Naturaleza:** documento de **definición** (no implementación). Especifica qué pregunta el
> wizard, qué genera y cómo se conecta con el contrato (#4010) y las capabilities (#4011).
> **Estado:** documento vivo — se revisa al firmar B (#4010) y C (#4011), y al entrar a la
> Ola 9 (implementación). Las secciones marcadas _sujeto a firma de B/C_ no son definitivas.

## 0. Cómo leer este documento

El wizard es la **pieza visible** del desacople: corrés el kernel pelado, respondés un setup
guiado y al final tenés una **instancia configurada para tu producto**. Volver a correr el
wizard = otro producto, mismo kernel.

En lo concreto, el wizard es un **generador de configuración**: produce el **adaptador de
producto** — una variante serializada de `.pipeline/config.yaml` + la selección de
capabilities/plugins de la épica C. No es la parte difícil del desacople (esa es C); es la
parte que materializa el "configurable + extraíble" y separa lo "genérico" de "Intrale".

| Pieza | Qué es | Quién la define |
|-------|--------|-----------------|
| **Kernel pelado** | El orquestador genérico sin saber qué producto corre. | Ola 9 (implementación) |
| **Wizard** | Setup guiado que recoge inputs y genera el adaptador. | Esta épica (spec) + Ola 9 (impl) |
| **Adaptador** | Config + selección de capabilities = la parte que sabe que el producto es Intrale. | Generado por el wizard |
| **Contrato (#4010)** | Esquema formal que el adaptador debe cumplir para que el kernel lo cargue. | EP-OLA8-B |
| **Capabilities (#4011)** | Catálogo de plugins/skills que el wizard ofrece elegir. | EP-OLA8-C |

> **Trazabilidad de CA:** cada sección de este documento cubre uno o más criterios de
> aceptación del comment de PO ([#4833113385](https://github.com/intrale/platform/issues/4013#issuecomment-4833113385)).
> El mapeo está en la [§8 (Cobertura de criterios)](#8-cobertura-de-criterios).

---

## 1. Modelo de amenaza

> Cubre **CA-10** (modelo de amenaza explícito). Se ubica antes de inputs/outputs a propósito:
> el wizard es, en los hechos, **un generador de configuración ejecutable**, y eso lo convierte
> en superficie de ataque de primer orden. Frame aportado por el agente `security`
> ([#4832608582](https://github.com/intrale/platform/issues/4013#issuecomment-4832608582))
> y suscrito por `guru` ([#4833067781](https://github.com/intrale/platform/issues/4013#issuecomment-4833067781)).

**El adaptador es un boundary de confianza.** Captura **comandos de build/test**, **paths** y la
**selección de plugins/capabilities**, y produce un artefacto que el kernel después **ejecuta**.
Por lo tanto:

- **Comandos + plugins = código.** Cargar un adaptador equivale a **confiar en su autor**. No
  es "leer un YAML inofensivo": es ejecutar lo que ese YAML referencia.
- **El input del operador es no confiable** hasta validarse. Metacaracteres de shell en un
  comando, `../` en un path o un plugin desde una URL arbitraria son vectores de RCE / path
  traversal / carga de código no verificado.
- **La frontera de secretos se respeta:** el adaptador **referencia** secretos por nombre/ruta
  del store (`~/.claude/secrets/credentials.json`, fuente única), **nunca los embebe**.

Los seis requisitos OWASP que materializan este modelo de amenaza están transcriptos en la
[§6 (Criterios de seguridad heredados a Ola 9)](#6-criterios-de-seguridad-heredados-a-ola-9) como
**CA-10…CA-14**, bloqueantes de la implementación (no de esta definición).

---

## 2. Inputs (qué pregunta)

> Cubre **CA-1** (enumeración de inputs con tipo y formato) y **CA-2** (esquema de validación por
> input, rechazo con mensaje claro). Cada fila se cruza contra
> [`inventario-frontera.md`](./inventario-frontera.md) para no dejar afuera nada hardcodeado hoy.

El wizard recoge los acoplamientos que hoy viven hardcodeados en `config.yaml` / `CLAUDE.md` /
`.pipeline/*.js`. La columna **Inventario** referencia la sección del inventario de frontera
donde ese acoplamiento está clasificado: si una fila no tuviera correspondencia, sería un
acoplamiento omitido (no es el caso — todas cruzan).

| Input | Tipo | Formato / regex | Validación | Rechazo (mensaje claro, no saneo silencioso) | Inventario |
|-------|------|-----------------|------------|----------------------------------------------|------------|
| **stack** | enum (del catálogo curado) | uno de los stacks soportados (ver §3) | pertenece al catálogo de C (#4011); no texto libre | "Stack no soportado. Elegí uno del catálogo: kotlin-compose, node, …" | §1.1, §6 crítico #3 (skills dev/qa/ux por stack) |
| **labels de dominio** | lista de strings | `^[a-z0-9:_-]+$` | charset estricto; longitud ≤ 50; sin duplicados | "Los labels usan minúsculas, números, `:` `_` `-`. Ej.: `area:pipeline`. Reintentá:" | §2.1 (`dev_skill_mapping`, `dev_routing_priority`) — crítico #1 |
| **mapeo label→skill** | tabla `label → skill` | label válido (arriba) → skill del catálogo | cada label mapea a un skill existente del adaptador; sin label sin skill | "El label `app:x` no apunta a ningún skill del adaptador." | §2.1 — crítico #1 (tabla de ruteo inyectable) |
| **convención de ramas** | template string | patrón con placeholders (`agent/<issue>-<slug>`, base `origin/main`) | placeholders conocidos; prefijo sin metacaracteres de path | "El patrón de rama solo admite `<issue>`, `<slug>`, `<desc>` como placeholders." | §2.2 (`CLAUDE.md: Ramas y PRs`), §2.3 (convención `agent/*`) |
| **gates de QA** | selección de pipeline de gates | secuencia ordenada de gates conocidos (`qa → tester → po`) | cada gate referencia una fase/skill existente; orden válido | "El gate `xxx` no existe. Gates disponibles: qa, tester, po, review." | §4 (gates de QA), §2.2 (`Gate de QA obligatorio`) |
| **dominio** | hostname | hostname válido (RFC 1123) | sin esquema `http(s)://`, sin path, sin puerto salvo explícito | "Ingresá un hostname válido (ej.: `api.intrale.com`), sin `https://` ni rutas." | §3 (frontera de secretos/auth — scopes por entorno) |
| **comandos de build** | lista (cmd + args[]) | `cmd` = ejecutable; `args` = array de tokens | **NO** string único; se parsea a `cmd + argsArray`; sin metacaracteres de shell | "El comando se ingresa como ejecutable + argumentos separados, no como línea de shell." | §2.2 (`Comandos de build`), §4 (`APK por flavor`) — datos no confiables (CA-10) |
| **comandos de test** | lista (cmd + args[]) | igual que build | igual que build; sin `; && \| $(...)` backticks | "Sin metacaracteres de shell (`;`, `&&`, `\|`, `$(...)`). Ingresá ejecutable + args." | §1.1 (`tester`), §4 (gates QA) |
| **paths** | lista de paths | relativos al root del adaptador | canonicalizar (`path.resolve`); confinar al root; rechazar absolutos y `../` que escapen | "El path se sale del workspace del producto. Usá rutas dentro del root del adaptador." | §2.3 (`.pipeline/` embebido — crítico #2), §2.2 (paths del repo) |
| **concurrencia / umbrales** | enteros por rol | `≥ 1`, ≤ tope de hardware | rangos numéricos; coherencia con recursos declarados | "La concurrencia de `qa` debe ser ≥ 1 y ≤ 2 según el hardware declarado." | §2.1 (límites de concurrencia / umbrales de recursos), §4 |
| **selección de capabilities** | lista (del catálogo C) | ids del registro de capabilities (#4011) | allowlist del registro; sin rutas/URLs arbitrarias (CA-12) | "La capability `x` no está en el registro firmado. Solo se cargan capabilities del catálogo." | §1.1 (skills como capabilities de stack), §6 crítico #3 |

**Reglas transversales de validación (CA-2):**

- El wizard **rechaza con mensaje accionable y re-pregunta**, no sanea en silencio ni aborta la
  corrida entera (ver UX-G4 en §5).
- Cada esquema sigue convenciones ya vigentes en el repo: labels `^[a-z0-9:_-]+$`, ramas contra
  el formato de `CLAUDE.md`, dominio como hostname. El mecanismo de validación del lado kernel se
  nombra (JSON-Schema / Konform), **no se implementa** acá (eso es Ola 9).
- Los **comandos nunca se capturan como string de shell único**: se capturan como `cmd` +
  `args[]` para habilitar ejecución sin shell intermedia en la implementación (CA-10).

---

## 3. Wizard activo (no formulario pasivo)

> Cubre **CA-3** (recomienda con rationale sobre catálogo curado) y **CA-7** (recomendaciones
> aceptadas/override-adas quedan auditadas y alimentan el adaptador).

El wizard **no es un formulario en blanco**: para cada decisión funcional/de stack se apoya en
`guru`/`architect` y **recomienda una opción con rationale**, sobre un **catálogo curado** de
stacks/capabilities soportados. El operador elige **sobre opciones sugeridas**, nunca ante hoja
en blanco.

**Reglas:**

1. **Catálogo curado y amplio desde el arranque.** Los stacks más usados hoy (p. ej.
   `kotlin-compose` = el de Intrale, `node`, …). El catálogo lo provee la épica C (#4011);
   sin catálogo, el wizard no tiene de dónde elegir → _sujeto a firma de C_.
2. **Prohibido recomendar fuera del catálogo.** El arquitecto solo puede recomendar stacks que
   el kernel pueda **ejecutar** (que tengan capability/skill en el registro). Recomendar fuera
   del catálogo = humo, y queda **explícitamente prohibido** en la spec.
3. **Recomendación con rationale visible.** Cada paso muestra `[recomendado: X]` + el porqué.
4. **Override auditado (CA-7).** Si el operador elige distinto del recomendado, la **decisión +
   el rationale** quedan registrados (decisión, opción recomendada, opción elegida, motivo) y
   **alimentan el adaptador generado** — no solo se persisten en un log aparte; se muestran al
   operador en el momento (ver UX-G2).
5. **Agnosticismo de dominio (dependencia de C).** Hoy `guru`/`architect` operan en contexto
   Intrale; para asesorar un producto en blanco deben volverse agnósticos. Es otra pieza del
   desacople que depende de C — _sujeto a firma de C_.

---

## 4. Outputs (qué genera)

> Cubre **CA-4** (salida = adaptador = variante de config + selección de capabilities),
> **CA-5** (valida contra el contrato #4010) y **CA-6** (multi-proyecto namespaceado).

### 4.1. El adaptador = variante de `config.yaml` + selección de capabilities (CA-4)

La salida del wizard es el **adaptador de producto**: una **variante serializada** del artefacto
que hoy es `.pipeline/config.yaml` (que parametriza `pipelines.*.fases`, `skills_por_fase`,
`concurrencia`, el mapeo `labels`→skill, `prioridad_labels`, gates/ventanas) **+** la selección
de capabilities/plugins de C.

El fragmento real de `config.yaml` que hoy hardcodea el ruteo de Intrale es exactamente lo que el
wizard generaría a partir de los inputs de §2 (ejemplo **real**, no pseudo-config):

```yaml
# Fragmento de un adaptador generado — equivalente a .pipeline/config.yaml hoy
dev_skill_mapping:
  "area:pipeline": "pipeline-dev"   # capability seleccionada en §3
  "area:backend":  "backend-dev"
  "app:client":    "android-dev"
  "app:business":  "android-dev"
  "app:delivery":  "android-dev"
  "area:web":      "web-dev"
  default:         "backend-dev"

# Skills/capabilities por fase — la lista sale de la selección de capabilities (C)
skills_por_fase:
  dev:          [backend-dev, android-dev, web-dev, pipeline-dev]
  verificacion: [tester, security, qa]
  aprobacion:   [review, po, ux, architect]
```

Para **otro producto**, el mismo wizard generaría otro `dev_skill_mapping` (otros labels, otros
skills del catálogo) sin tocar el kernel. Esto es el desacople en acción: la **tabla de ruteo es
inyectable por el adaptador**, no hardcodeada en el kernel (crítico #1 del inventario, §6).

### 4.2. Valida contra el contrato kernel↔adaptador (CA-5) — _sujeto a firma de #4010_

El **esquema de salida del adaptador valida contra el contrato (#4010)**: si el output diverge
del contrato, **el adaptador no carga**. El mecanismo de validación del lado kernel es
**JSON-Schema / Konform** (se nombra; no se implementa acá).

> **Riesgo declarado:** la spec **no fija un esquema de salida propio que compita con B**. El
> esquema lo define el contrato (#4010); este documento solo declara que el output **debe**
> validar contra él. Cerrar el esquema acá lo volvería especulativo (ver §7).

### 4.3. Multi-proyecto namespaceado (CA-6)

Una instalación del kernel gestiona **N adaptadores**: re-correr el wizard genera **otro**
adaptador con estado namespaceado, **sin pisar los existentes**. El scheduler es único (no N
pipelines en paralelo — constraint heredado de EP8-F/G), pero cada producto vive en su propio
namespace de estado/config. El comportamiento ante re-corrida y no-pisado se detalla en UX-G5
(§5).

---

## 5. Flujo del setup guiado

> Cubre **CA-8** (mockup legible para un operador que nunca vio el kernel) e incorpora las
> guidelines de UX ([#4833188329](https://github.com/intrale/platform/issues/4013#issuecomment-4833188329)):
> transcript anotado (UX-G1), recomendación con escape claro (UX-G2), progreso + resumen
> revisable (UX-G3), errores accionables (UX-G4), reanudable/no destructivo (UX-G5),
> accesibilidad de terminal sin depender solo de color (UX-G6).

El mockup se lee como un **guion de conversación** (transcript anotado de una corrida real): voz
del wizard (`›`) y voz del operador (`»`) diferenciadas; estado por símbolo textual además de
color (`[recomendado]`, `[✓]`, `[✗]`) para terminales monocromáticas y logs sin ANSI.

```text
═══════════════════════════════════════════════════════════════
  Kernel operativo · Setup de producto                Paso 1/8
═══════════════════════════════════════════════════════════════

› ¿Qué stack usa tu producto?
  [recomendado: kotlin-compose]  — es el stack con más capabilities
  curadas y QA E2E con emulador ya soportado.
  Otras opciones del catálogo: node, python-fastapi.

» node

  [✓] stack = node   (override del recomendado)
      ↳ auditado: recomendado=kotlin-compose, elegido=node,
        motivo="el producto es un servicio Node puro".

───────────────────────────────────────────────────────────────
  Setup de producto                                   Paso 2/8
───────────────────────────────────────────────────────────────

› Labels de dominio que rutean issues a skills.
  [recomendado: area:backend, area:web]

» area:Backend

  [✗] Rechazado: los labels usan minúsculas, números, ':' '_' '-'.
      Ej.: area:backend. Reintentá:

» area:backend

  [✓] labels = [area:backend]

───────────────────────────────────────────────────────────────
  Setup de producto                                   Paso 6/8
───────────────────────────────────────────────────────────────

› Comando de build (ejecutable + argumentos, sin línea de shell).
  [recomendado para node: "npm" ["run","build"]]

» npm run build && rm -rf /

  [✗] Rechazado: sin metacaracteres de shell (';', '&&', '|',
      '$(...)'). Ingresá ejecutable + args. Ej.: npm ["run","build"].

» npm  run build

  [✓] build = { cmd: "npm", args: ["run","build"] }

───────────────────────────────────────────────────────────────
  Resumen antes de generar                            Paso 8/8
───────────────────────────────────────────────────────────────

› Esto es lo que voy a generar (adaptador "mi-servicio-node"):

    stack ............ node
    labels ........... area:backend
    ruteo ............ area:backend → backend-dev
    build ............ npm run build
    test ............. npm test
    capabilities ..... node-build, github-delivery
    secretos ......... referenciados por nombre (no embebidos)

  Se escribe en: adapters/mi-servicio-node/   (no pisa existentes)

  ¿Confirmás? [s/N]
» s

  [✓] Adaptador generado y validado contra el contrato (#4010).
      [✓] sin secretos en texto plano   [✓] paths confinados al root
```

**Garantías de UX que la spec fija sobre el flujo:**

- **UX-G3 · Progreso + resumen revisable:** indicador `Paso N/8` siempre visible; **resumen final
  revisable antes de escribir** ("esto es lo que voy a generar — ¿confirmás?"). El operador nunca
  queda sin saber cuánto falta ni qué se va a commitear.
- **UX-G4 · Errores accionables:** cada rechazo indica (a) qué campo, (b) por qué en lenguaje
  humano (no el regex crudo), (c) un ejemplo válido, (d) re-pregunta en vez de abortar.
- **UX-G5 · Reanudable / no destructivo:** ante Ctrl-C a mitad o re-corrida, no se pisan
  adaptadores existentes (CA-6); deseablemente se puede retomar o pre-cargar respuestas previas
  como defaults (clave para la UX multi-proyecto: el adaptador N+1 no se siente como empezar de
  cero).
- **UX-G6 · Accesibilidad de terminal:** el estado no depende solo de color — se usan símbolos /
  etiquetas textuales (`[recomendado]`, `[✓]`, `[✗]`), legibles en terminal monocromática y en
  logs sin ANSI (WCAG: el color no es el único canal).

---

## 6. Criterios de seguridad heredados a Ola 9

> Cubre **CA-10…CA-14**. Transcriptos **textualmente** del comment de PO
> ([#4833113385](https://github.com/intrale/platform/issues/4013#issuecomment-4833113385), sección D),
> que a su vez recoge el análisis de `security` y `guru`. Son **bloqueantes para la
> implementación (Ola 9)**, NO para esta definición. No se parafrasean: se copian para no diluir
> el requisito.

- **CA-10** — Command/Argument Injection (OWASP A03, **crítico**): los comandos build/test del
  adaptador se ejecutan **sin shell intermedia** (`spawn(cmd, argsArray, {shell:false})`),
  tratados como datos no confiables. La spec documenta el **modelo de amenaza**: cargar un
  adaptador = confiar en su autor.
- **CA-11** — Path Traversal (A01, **alto**): todo path se canonicaliza (`path.resolve`) y se
  confina al root del adaptador; se rechazan absolutos y symlinks que escapen.
- **CA-12** — Carga de plugins/capabilities = ejecución de código (A08, **crítico**):
  allowlist/registro firmado, verificación de integridad (hash/firma) antes de cargar, principio
  de mínimo privilegio (el adaptador declara qué capabilities necesita).
- **CA-13** — Gestión de secretos (A02/A05, **alto**): el adaptador **referencia** secretos por
  nombre/ruta del store (`~/.claude/secrets/credentials.json`, fuente única), **nunca los
  embebe**; se valida que el output sea commiteable sin filtrar secretos.
- **CA-14** — Template/Config Injection (A03, medio): la salida se serializa con serializador
  seguro (no string-concatenation de templates) y se valida contra esquema.

> **No diluir:** estos cinco criterios + el modelo de amenaza de §1 cubren los 6 vectores OWASP
> aportados por `security`. Quedan como **criterios de aceptación de las sub-issues de Ola 9**,
> marcados como bloqueantes de implementación.

---

## 7. Documento vivo / dependencias

> Cubre **CA-9** (referencia explícita a #4010 y #4011, declaración de documento vivo).

Esta spec es un **documento vivo**. Se redacta **referenciando los borradores** de B y C y se
**revisa cuando esos firmen**. Cerrar inputs/outputs como definitivos **antes** que el contrato
(B) y el catálogo de capabilities (C) tengan forma volvería la spec **especulativa**.

| Dep | Épica | Relación | Estado en esta spec |
|-----|-------|----------|---------------------|
| Media | [#4009](https://github.com/intrale/platform/issues/4009) · EP-OLA8-A · Inventario de frontera | Línea base de acoplamientos = lista de inputs (§2). | ✅ Cerrado y mergeado; §2 cruza contra él. |
| **Fuerte** | [#4010](https://github.com/intrale/platform/issues/4010) · EP-OLA8-B · Contrato kernel↔adaptador | El esquema de salida del adaptador **ES** el contrato. Define multi-proyecto. | ⏳ §4.2 declarada _sujeto a firma de B_; no se fija esquema propio. |
| **Fuerte** | [#4011](https://github.com/intrale/platform/issues/4011) · EP-OLA8-C · Capabilities/plugins | El wizard **selecciona** del catálogo curado de C. | ⏳ §3 (catálogo) y §2 (selección) _sujeto a firma de C_. |

**Revisión al firmar B y C:** cuando #4010 cierre, fijar el esquema de validación de §4.2 contra
el contrato real. Cuando #4011 cierre, fijar el catálogo curado de §3 y el agnosticismo de
dominio de `guru`/`architect`. Hasta entonces, las secciones marcadas _sujeto a firma_ no son
definitivas.

---

## 8. Cobertura de criterios

> Chequeo de consistencia documental (no Gradle — es docs): cada CA-1…CA-9 tiene una sección
> rastreable; CA-10…CA-14 están transcriptos textualmente.

| Criterio | Dónde se cubre |
|----------|----------------|
| CA-1 (inputs enumerados, cruzados c/ inventario) | §2 (tabla + columna Inventario) |
| CA-2 (esquema de validación por input, rechazo claro) | §2 (columnas validación/rechazo + reglas transversales) |
| CA-3 (wizard activo, catálogo curado, no recomendar fuera) | §3 |
| CA-4 (salida = adaptador = config + capabilities) | §4.1 (con fragmento real de `config.yaml`) |
| CA-5 (valida contra contrato #4010, JSON-Schema/Konform) | §4.2 |
| CA-6 (multi-proyecto namespaceado, sin pisar) | §4.3 + UX-G5 (§5) |
| CA-7 (recomendaciones override-adas auditadas, alimentan adaptador) | §3 (regla 4) + mockup §5 |
| CA-8 (mockup del setup guiado) | §5 |
| CA-9 (referencia #4010/#4011, documento vivo) | §7 + encabezado |
| CA-10…CA-14 (seguridad, textuales) | §6 (transcriptos) + §1 (modelo de amenaza) |

---

## 9. Notas de alcance

- **Cero código.** Esta épica produce **especificación**, no implementación. Cualquier snippet
  (YAML, mockup) es **ilustrativo** dentro del `.md`. No hay wizard ejecutable ni stubs.
- **Cero cambios productivos.** El entregable agrega `docs/desacople-kernel/wizard-setup.md` y
  edita `docs/desacople-kernel/README.md`. No toca `.pipeline/` productivo ni código del producto
  (verificable con `git diff --name-only main`).
- **Sin secretos ni comandos ejecutables embebidos** (coherente con CA-13): la spec **referencia**
  el store de secretos y usa comandos solo como ejemplo ilustrativo, no como instrucción
  ejecutable.
- **Documento vivo.** Se revisa al firmar B (#4010) y C (#4011) y al entrar a la Ola 9. Las marcas
  _sujeto a firma_ son deliberadas: señalan lo que no debe cerrarse antes de tiempo.
