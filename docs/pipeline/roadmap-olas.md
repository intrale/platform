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
interna `9` = Ola 9.2 · interna `10` = Ola 9.4 · interna `13` = Ola Proveedores · interna `15` = Ola Tablero fiel
(que se ejecuta 13.ª). Decir "la ola 8" sin aclarar cuál es una fuente garantizada de malentendido.
La **posición** en el tablero es una tercera cosa: es el orden de ejecución y se ajusta al reordenar.
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

> **Última re-validación:** 2026-09-18 (Leo por Telegram, 10:44–11:37 ART; asentado en `meta.note` de
> `waves.json`). Decisiones de ese día: (a) la **Ola Vault sube** y corre antes que la app operadora
> (el ensayo de GATE 1 del 16/09 falló porque la firma por botón exige el vault encendido);
> (b) la **separación kernel↔Intrale se ejecuta completa antes de empezar la app operadora**
> —"si tenemos todo listo para separar, tenemos que hacerlo; si encima empezamos la app, después
> impactamos las dos cosas"—, lo que restituye el camino crítico canónico frente a una propuesta
> de adelantar la app; (c) se elimina la bolsa "EP-9 · Deuda operativa": la deuda real va a la ola
> del tema al que pertenece; (d) la app operadora deja de ser una ola única y pasa a **cuatro olas
> incrementales** hasta cubrir toda la funcionalidad del dashboard actual. La **posición** es lo que
> se lee en el tablero y se corre al reordenar; la **referencia** estable es el título (R4).

| Posición | Bloque | Por qué acá | Estado |
|----------|--------|-------------|--------|
| ✅ | **Release firmado del kernel** (E1) | Sin release publicado, `consume:true` no tiene de dónde consumir. Raíz de todo. | **Hecho** — `v0.1.2` publicado y firmado |
| ✅ | **Ola 9.4 · Partir config + externalizar el estado operativo** (E2, épico #5107) | Envoltorio único de acceso al estado, migración de los accesos con guardrail, namespaceado por proyecto, partición de `config.yaml`, store durable y almacenamiento externo **preparados y ensayados en seco**. El encendido real quedó como cola (ver posición 5.ª). | **Cerrada 16/09** (interna 10) |
| **1.ª · activa** | **Ola Proveedores · Antigravity encendido y retiro de los gratuitos** (épico #6856) | Cuota adicional paga (Google vía `agy`) con round-trip real, catálogo de modelos corregido, matriz modelo×agente firmada, y baja del ruteo de los proveedores gratuitos que no editan archivos ni reportan consumo. Descomprime la cuota de Anthropic antes de las olas grandes. | Abierta 16/09 (interna 13) — 10 issues, 8 cerrados; queda #6861 → épico |
| **2.ª** | **Ola 9.4.1 · Ambiente de pruebas del CORE** (épico #7102) | Los tests del CORE dejan de correr contra la instalación productiva: resolvedor único de ambiente y `pipelineDir` de prueba. Precondición de higiene para todo lo que sigue. | Planificada (interna 11) — 7 issues |
| **3.ª** | **Ola E8 · Contabilidad de cuota y auditor del modelo operativo** (épico #7186) | Libro contable de cuota por proveedor y auditor (#6809) que propone plan, schedule y cadena de respaldo; nada de eso se decide a mano. Con Antigravity encendido, la cuota es la variable que gobierna el paralelismo. | Planificada (interna 12) — 10 issues |
| **4.ª** | **Ola Vault · Encendido seguro del vault de secretos** (épico #5215) | Los secretos dentro del repo se pierden en cada respawn y aparecieron copiados en worktrees viejos; la **firma por botón de GATE 1 exige `vault.enabled`**. Es la cerradura que hay que poner antes de abrir el modelo operativo hacia afuera. | Planificada (interna 14) — 13 issues · **subida el 18/09** (antes iba 6.ª) |
| **5.ª** | **Ola Encendido · Estado externo del modelo operativo con firma del operador** (cola de 9.4 / E2, #7194) | El encendido real de lo que 9.4 dejó preparado: flips con firma del operador en la terminal, migración con paridad, sonda positiva y ensayo de vuelta atrás. **Prerrequisito duro de la app operadora**: un celular no lee archivos locales. | Planificada (interna 16) |
| **6.ª** | **Ola Separación · Partir los skills híbridos** (Ola 9.3 / E6, épico #7027) | Grande y la **más riesgosa**: el producto puede perder reglas propias (strings, flavors, gates de QA) sin que nadie lo note. Su red de contención, el guardrail anti-regresión **#5068**, ya está cerrada. Mecanismo al kernel, contenido Intrale al adaptador. | Planificada (interna 17) — épico en definición |
| **7.ª** | **Ola Separación · Red de seguridad y launcher del corte** (E3 + E5, épico #7347) | Precondición del cutover: botón de pánico independiente del sistema que se corta, tres niveles de recuperación, snapshot con restore probado, timeout de decisión y **simulacro verde obligatorio**. Sin ensayo, no hay corte. | Planificada (interna 18) — épico en definición |
| **8.ª** | **Ola Separación · Corte con freeze** (Ola 9.5 / E7, épico #7348) | Punto de no retorno: canary de `kernel.consume`, ventana de corte agendada y vacía (drenaje previo), el kernel pineado pasa a autoritativo y el motor embebido queda congelado como destino de rollback. | Planificada (interna 19) — épico en definición |
| **9.ª** | **Ola App operadora · Base y firma** (E9, épico #7349) | Prueba de fuego del desacople: la app nace como **proyecto nuevo operado por el pipeline** (tercer proyecto: kernel, Intrale, app). Login del operador, estado inicial y firma de gates desde el celular. Depende dura de la 5.ª (estado externo) y de que la separación esté hecha, para no impactar kernel y app a la vez. | Planificada (interna 20) — épico en definición |
| **10.ª** | **Ola App operadora · Operar el pipeline** (épico #7350) | Pausa total/parcial y allowlist, roadmap de olas (abrir, cerrar, reordenar con confirmación, sumar/quitar issues), issues por fase con rebotes y acciones. | Planificada (interna 21) — épico en definición |
| **11.ª** | **Ola App operadora · Equipo, proveedores y productos** (épico #7351) | Equipo y matriz modelo×agente, proveedores (cuota del libro contable, gateos, cadena de respaldo, salud multi-provider, propuestas del auditor) y productos. | Planificada (interna 22) — épico en definición |
| **12.ª** | **Ola App operadora · Métricas e historia** (épico #7352) | KPIs, costos y tokens por sesión/agente/ola, historial de eventos, DORA y velocidad, recomendaciones con gate humano y logs de agentes. Con esta ola la app cubre **toda** la funcionalidad del dashboard actual. | Planificada (interna 23) — épico en definición |
| **13.ª** | **Ola Tablero fiel · El dashboard muestra el estado real de la ola** | Que lo que el operador ve coincida con el estado real de la ola, sin mezclas ni fotos viejas. Va última porque el dashboard local deja de ser la superficie principal cuando la app operadora esté completa. | Planificada (interna 15) — 16 issues |

**Paralelizable en cualquier momento** (no toca el camino crítico): runbook de continuidad y modo
degradado (E4) · reconciliación automática del registro (**#5055**). Los seis épicos nuevos
(#7347–#7352) están en `needs-definition`, sin allowlist, y se bajan a historias con `/planner split`
recién al abrir cada ola, con OK del operador (R6, R7).

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
| **Ola 9.4** · Partir config + externalizar el estado operativo (E2, épico #5107) | 10 | 16/09 | cadena #5108→#5113 preparada; el encendido real pasa a la Ola Encendido (#7194) |

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
