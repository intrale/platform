# Roadmap oficial de ejecución de olas — modelo operativo

> **Estado:** documento canónico y vivo. Es el **destino que `.pipeline/waves.json` ya declara**
> en `meta.roadmap_doc` (referencia que existía desde el 17/07 apuntando a un archivo inexistente).
> **Naturaleza:** roadmap de **ejecución** — en qué orden se abren las olas y **por qué ese orden**.
> No redefine la frontera kernel↔adaptador ([`contrato-kernel-adaptador.md`](contrato-kernel-adaptador.md)),
> ni el qué se mueve ([`kernel-migration-plan.md`](kernel-migration-plan.md)), ni el modelo de ola en sí
> ([`modelo-planificacion-multi-ola.md`](modelo-planificacion-multi-ola.md)). Los consume.
> **Audiencia:** Commander, `planner`, `pipeline-dev`.

## Por qué existe este documento

Hasta hoy el orden de las olas vivía repartido entre `waves.json`, tres documentos de diseño y
conversaciones de Telegram. Eso produjo **desfasajes reales y repetidos**, no hipotéticos:

| Desfasaje observado | Consecuencia | Regla que lo previene |
|---------------------|--------------|------------------------|
| 13 issues CLOSED en GitHub seguían `pending` en el registro de la Ola 8 (25–27/07) | Se reportó una ola terminada como si tuviera pendientes; se planificó sobre datos falsos | [R1](#r1--github-es-la-fuente-de-verdad-el-registro-es-proyección) |
| #5065 cerrado 12:16 y el tablero lo seguía mostrando en cola (27/07) | Un issue entregado seguía contando como trabajo vivo en la allowlist | [R1](#r1--github-es-la-fuente-de-verdad-el-registro-es-proyección) · [R2](#r2--cierre-de-ola--reconciliación-obligatoria) |
| `planned_waves` conserva "Ola 9 — migración física" como futura, cuando 9.1 ya cerró y 9.2 está en curso | El horizonte planeado miente: muestra como pendiente algo ya a medio ejecutar | [R3](#r3--el-horizonte-se-re-valida-en-cada-cierre-de-ola) |
| Número interno de ola (1,2,6,7,8,9) ≠ identificador estratégico (9.1, Puente, 9.2) | Confusión permanente al hablar de "la ola 8" o "la 9" | [R4](#r4--dos-numeraciones-distintas-nunca-razonar-con-la-interna) |
| Cadena #5065→#5068 declarada sólo en el texto del épico | Los 4 hijos salían en paralelo: el contrato se escribía mientras alguien ya lo consumía | [R5](#r5--las-dependencias-se-declaran-en-formato-máquina-no-en-prosa) |
| Al cerrar la Ola 8, el backlog entero (121 issues) entró a la cola | El Pulpo entró en bucle de muerte y tumbó al Commander 12 h (#5073) | [R6](#r6--abrir-una-ola-es-un-acto-atómico-de-dos-archivos) |

**El patrón común:** el estado de la ola se escribió una vez y nadie lo volvió a cruzar contra la
realidad. Este documento fija el orden **y** las reglas que lo mantienen sincronizado.

---

## 1. Reglas anti-desfasaje (normativas)

### R1 · GitHub es la fuente de verdad; el registro es proyección

El estado real de un issue lo dice **GitHub**, siempre. `waves.json` y el tablero son **vistas
derivadas** que pueden quedar viejas. Ante discrepancia, gana GitHub y se corrige el registro — nunca
al revés.

- Prohibido reportar avance de ola leyendo sólo el registro.
- La reconciliación automática está pedida en **#5055** (aprobada, `priority:high`). Mientras no exista,
  la reconciliación es **manual y obligatoria** en cada cierre de ola y en cada reporte de estado.
- Corolario: un issue `CLOSED` en GitHub **nunca** puede seguir en la allowlist de trabajo habilitado.

### R2 · Cierre de ola = reconciliación obligatoria

Una ola **no se cierra ni se archiva** sin antes cruzar issue por issue contra GitHub y dejar el
registro coincidiendo. Archivar con estados desfasados congela la mentira: la Ola 8 quedó archivada
con 13 falsos pendientes y hubo que corregirla dos días después.

### R3 · El horizonte se re-valida en cada cierre de ola

`planned_waves` es un **horizonte tentativo**, no un archivo histórico. Al cerrar cualquier ola:

1. Se borra de `planned_waves` todo lo que ya se ejecutó (total o parcialmente).
2. Lo parcialmente ejecutado se reemplaza por **lo que queda** de ese bloque, con su identificador real.
3. Se confirma que el primero del horizonte sigue siendo el correcto según §2 de este documento.

Una entrada planeada que describe algo ya en curso es un bug de datos, no una nota histórica.

### R4 · Dos numeraciones distintas; nunca razonar con la interna

| Numeración | Qué es | Cómo se usa |
|------------|--------|-------------|
| **Interna** (`number` en `waves.json`) | Contador incremental del registro. **Sin significado semántico.** | Sólo como clave técnica de archivado. |
| **Estratégica** (`name`: `Ola 9.2 — …`, `Ola Puente — …`) | El identificador real del bloque de trabajo. | **La única válida** para hablar, planificar y reportar. |

Hoy conviven: interna `6` = Ola 9.1 · interna `7` = Ola Puente · interna `8` = alta de producto nuevo ·
interna `9` = Ola 9.2. Decir "la ola 8" sin aclarar cuál es una fuente garantizada de malentendido.
**Siempre nombrar por identificador estratégico.**

### R5 · Las dependencias se declaran en formato máquina, no en prosa

Escribir "primero #5065, después #5066" en el cuerpo del épico **no frena nada**: el pipeline no lee
prosa. Toda cadena estricta exige, además del texto:

- `blocked:dependencies` en el padre apuntando a los hijos, y
- el **freno efectivo** aplicado a cada hijo que no debe arrancar todavía.

Sin las dos cosas, los hijos salen en paralelo. Ya pasó con #5065–#5068.

### R6 · Abrir una ola es un acto atómico de dos archivos

`waves.json` **y** la allowlist se actualizan juntos, en el mismo movimiento. Un issue habilitado en
uno y ausente del otro es lo que produjo, al cerrar la Ola 8, que entrara el backlog completo a la cola.

- **Allowlist vacía ≠ pausa.** Vacía significa "todo habilitado". El halt total es explícito.
- La allowlist incluye **hijos y dependencias recursivas** del alcance de la ola.

### R7 · Gate humano entre olas; tag de rollback antes de mover archivos

Ninguna ola arranca por silencio ni por automatismo (política fail-closed de operador ausente). Y toda
ola que **mueva archivos entre repos** exige un tag de retorno sobre `main` **antes** del primer commit
(precedentes: `pre-desacople-kernel-stable`, `pre-ola-9.2-stable`).

### R8 · Una ola termina en producto verificablemente funcionando

Criterio de cierre, no de apertura: al terminar, el producto queda igual de funcional o revertible en
minutos. Si una ola deja algo a medias que "se arregla en la próxima", eso **es** el desfasaje que
después hay que corregir.

---

## 2. Orden canónico hacia adelante

> **El orden lo fija el camino crítico, no la numeración.** Un identificador mayor puede ir antes que
> uno menor si destraba más trabajo. El camino crítico vive en
> [`corte-kernel-y-tres-proyectos.md` §7](corte-kernel-y-tres-proyectos.md): `E1 → E2 → (E3, E5) → E6 → E7 → E9`.

| Orden | Bloque | Por qué acá | Estado |
|-------|--------|-------------|--------|
| ✅ | **Release firmado del kernel** (E1) | Sin release publicado, `consume:true` no tiene de dónde consumir. Raíz de todo. | **Hecho** — `v0.1.2` publicado y firmado |
| **En curso** | **Ola 9.4 · Partir config + externalizar el estado operativo por proyecto** (épico #5107) | **Cuello de botella real.** Mientras el estado sea plano y global, dos proyectos se pisan: no hay multi-proyecto, no hay app operadora, no se puede encender el consumo en serio. Alcance ampliado por decisión del operador (28/07): incluye además el **encendido del store durable** y el **almacenamiento externo** del estado operativo. Cadena `#5108 → #5109 → #5110 → #5113`; **#5111** paralelo tras #5108; **#5112** totalmente paralelizable. | Abierta 28/07 — 6 hijos, #5108 y #5112 habilitados |
| **1.º** | **Ola 9.3 · Partir skills híbridos** (E6) | Grande y la **más riesgosa**: el producto puede perder reglas propias (strings, flavors, gates de QA) sin que nadie lo note. Su red de contención, el guardrail anti-regresión **#5068**, ya está cerrada — la red existe. | Sin épico creado |
| **2.º** | **Red de seguridad del corte** (E3) + **launcher/updater externo** (E5) | Precondición del cutover: botón de pánico independiente, snapshot verificado, timeout de decisión y **simulacro verde obligatorio**. Sin ensayo, no hay corte. | Sin épico creado |
| **3.º** | **Ola 9.5 · Cutover con freeze + observación** (E7) | Punto de no retorno. Ventana acotada y agendada, drenaje previo, motor local congelado como destino de rollback. | Sin épico creado |
| **4.º** | **App operadora móvil** (E9) | Prueba de fuego del desacople: si el kernel no puede operar un proyecto que no es Intrale, el corte no terminó. **Depende dura de E2** (una app móvil no lee archivos locales). | Sin épico creado |

**Paralelizable en cualquier momento** (no toca el camino crítico): runbook de continuidad y modo
degradado (E4) · cuota y prioridad por proyecto (E8) · deuda operativa y quick wins EP-9 ·
reconciliación automática del registro (**#5055**).

### 2.1 Por qué 9.4 va antes que 9.3

Aunque el número sugiera lo contrario:

1. **9.4 destraba; 9.3 no.** El estado namespaceado por proyecto habilita multi-proyecto, app móvil y
   consumo real del kernel. La 9.3 no destraba nada aguas abajo.
2. **9.3 sin guardrail es migrar sin red.** Su contención (#5068) es el último eslabón de la 9.2.
3. **Riesgo asimétrico.** Un error en 9.4 se ve enseguida (algo no arranca). Un error en 9.3 es
   silencioso: una regla del producto se evapora y se descubre semanas después.

---

## 3. Baseline cerrado (histórico verificado)

| Identificador estratégico | Interna | Cerrada | Entregados |
|---------------------------|---------|---------|------------|
| Ola seed #1 | 1 | 09/07 | — |
| Ola · Gates de firma del operador (épico #4570) | 2 | 12/07 | 21/21 |
| **Ola 9.1** · Migrar el repositorio del kernel (épico #4661) | 6 | 13/07 | cadena #4662→#4665 |
| **Ola Puente** · Kernel multi-producto (épico #4644) | 7 | 20/07 | 35 |
| Ola · Cierre de gestión de producto nuevo | 8 | 27/07 | 42 |
| **Ola 9.2** · Parametrizar los skills de orquestación (épico #5064) | 9 | 28/07 | cadena #5065→#5068 (4/4) |

Las olas 1–7 de la auditoría 2026-06 y la Ola 8 de definición del desacople (épicas #4009–#4014)
están cerradas y su salida son los documentos de diseño que este roadmap consume.

---

## 4. Checklists operativos

### 4.1 Abrir una ola

1. Reconciliar la ola anterior contra GitHub y archivarla (**R2**).
2. Re-validar el horizonte: sacar lo ya ejecutado, confirmar que el próximo bloque sigue siendo el de §2 (**R3**).
3. Tag de rollback sobre `main` si la ola mueve archivos entre repos (**R7**).
4. Crear el épico y los hijos vía `/planner split` — nunca a mano.
5. Declarar la cadena en formato máquina: `blocked:dependencies` + freno efectivo en los hijos que no arrancan (**R5**).
6. Actualizar `waves.json` **y** la allowlist en el mismo movimiento, con hijos y dependencias recursivas (**R6**).
7. Verificar que el alcance habilitado es exactamente el esperado, no el backlog entero.
8. OK humano explícito antes de habilitar el dispatch (**R7**).

### 4.2 Cerrar una ola

1. Cruzar issue por issue contra GitHub; corregir todo desfasaje **antes** de archivar (**R2**).
2. Confirmar que el producto quedó funcionando o revertible en minutos (**R8**).
3. Archivar con métricas reales (completados / fallidos / duración).
4. Re-validar el horizonte y dejar declarada la próxima ola según §2 (**R3**).
5. Confirmar que la allowlist quedó acotada al alcance siguiente y **no** abierta al backlog (**R6**).

### 4.3 Reportar estado de ola

- La tabla de estado la produce **siempre** el handler determinístico de olas, en su formato fijo.
- Antes de afirmar avance, cruzar contra GitHub (**R1**). Si el registro y GitHub difieren, se reporta
  el dato de GitHub y se corrige el registro.

---

## Referencias

- [`modelo-planificacion-multi-ola.md`](modelo-planificacion-multi-ola.md) — qué es una ola, ciclo de vida, campos prohibidos (anti-Sprint).
- [`waves-schema.md`](waves-schema.md) · [`waves-api.md`](waves-api.md) — esquema y API del registro.
- [`ola9-sub-olas-migracion.md`](ola9-sub-olas-migracion.md) — sub-olas 9.1–9.5 y gates entre ellas.
- [`corte-kernel-y-tres-proyectos.md`](corte-kernel-y-tres-proyectos.md) — camino crítico E1→E9, tres proyectos, rollback del corte.
- [`contrato-kernel-adaptador.md`](contrato-kernel-adaptador.md) · [`kernel-migration-plan.md`](kernel-migration-plan.md) — frontera y qué se mueve.
- [`kernel-coexistencia.md`](kernel-coexistencia.md) · [`kernel-updates.md`](kernel-updates.md) — etapas, versionado y distribución firmada.
- [`pausa-parcial.md`](pausa-parcial.md) — semántica de la allowlist (vacía ≠ pausa).
