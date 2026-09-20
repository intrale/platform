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
(que se ejecuta 13.ª) · interna `25` = Ola Confiabilidad del Pulpo (que se ejecuta 14.ª). Decir "la ola 8" sin aclarar cuál es una fuente garantizada de malentendido.
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
>
> **Ajuste 2026-09-18 (tarde, 17:25 ART):** se inserta la **Ola Propuestas · Commander proactivo y pausa de las
> recomendaciones** en la 4.ª posición, inmediatamente después de la Ola E8 (que le da el registro único #6807
> donde publicar). Motivo: las recomendaciones automáticas de agentes crecen a ~16–30 por día y hoy nacen como
> issues sueltos (2.292 abiertas); Leo decidió que no haya ningún "agente asesor" nuevo, sino que ese flujo
> entre al registro único y lo entregue el Commander proactivo en sus 3 tandas diarias. Todo lo que estaba
> después corre una posición.
>
> **Ajuste 2026-09-18 (18:10 ART):** Leo sumó a la misma Ola Propuestas las tres historias que cierran el
> circuito (migrar productores #6808, aceptación #6810, encaje #6811), que habían quedado sin ola. Excepción
> explícita a la regla de olas planificadas congeladas: sin ellas la ola entregaba sugerencias que no se podían
> aceptar ni ejecutar. Sigue siendo una ola chica (8 issues, concurrencia 2).
>
> **Ajuste 2026-09-18 (noche, 20:55 ART):** se agrega al **final** del horizonte la **Ola Confiabilidad del
> Pulpo · Rebotes justos y muertes bien clasificadas** (épico #7368, interna 25, 15.ª posición). Sale de la
> revisión de los 406 issues reales sin ola del 18/09: es la familia con más bugs repetidos del backlog (el mismo
> "muerte por cuota/API = rebote de código" levantado ocho veces) y la causa directa del incidente del 08/09
> (284M tokens en una noche y un solo PR). Leo aprobó el orden (a continuación de Tablero fiel) y la creación.
> Queda abierta, como pregunta aparte, si conviene adelantarla por delante de la app operadora: cada ola
> intermedia paga el costo de estos rebotes.
>
> **Ajuste 2026-09-19 (07:11 ART):** la **Ola Proveedores** cerró (11/11 en GitHub) y se promovió la
> **Ola 9.4.1 · Ambiente de pruebas del CORE** a activa con `/wave promote` (transacción atómica). Todo el
> horizonte corre una posición hacia arriba.
>
> **Ajuste 2026-09-19 (08:20 ART):** Leo sumó a la ola activa el issue **#7371** (Antigravity queda fuera de
> la cascada en silencio cada vez que `agy` se auto-actualiza por encima del pin: alertar al operador y
> política "versión por encima del máximo probado = advertencia"). Excepción explícita a la regla de olas
> acotadas: no es del tema de la ola, pero sin eso el proveedor recién encendido se pierde en cada
> auto-update del CLI (pasó el 18/09 22:09 con 1.2.7 y dejó al Commander mudo ~5 h). Mitigación inmediata
> aparte: pin subido a 1.2.7 (PR #7372). La ola pasa a 8 issues.
>
> **Ajuste 2026-09-19 (09:30 ART):** se inserta la **Ola Proveedores siempre vivos · Ciclo de vida automatizado
> de los CLIs** (épico #7376, interna 26) en la **3.ª posición, inmediatamente después de la Ola E8**. Sale de
> los dos incidentes de la semana: `agy` se auto-actualizó a 1.2.7 y quedó 12 h fuera de la cascada en silencio
> (18/09), y Codex quedó gateado con un crédito de reset sin canjear (11/09). Leo pidió que las actualizaciones
> de los tres CLIs (`claude`, `codex`, `agy`) y los resets de cuota se automaticen para que un update nunca deje
> al pipeline sin proveedor y un reset nunca se desaproveche. Va después de E8 porque "preferir la ventana
> fresca" necesita el libro contable de cuota (#6558/#6559/#6560); el resto es independiente. Split en 6 hijas
> (#7380–#7385) por funcionalidad entregable, con cadena 7380→7381→7382, 7383→7384, (7380,7383)→7385. #7371 (ola
> activa) sigue siendo la mitigación urgente para Antigravity. Todo lo que estaba después de E8 corre una posición.
>
> **Ajuste 2026-09-19 (12:50 ART):** se agrega la **Ola Canal del operador · Rediseño de los avisos por Telegram**
> (épico #7399, interna 27) en la **16.ª posición (última)**. Leo pidió repensar todo el esquema de notificación de
> agentes a Telegram: hoy el canal emite por evento del pipeline (~350 envíos el 19/09, la mayoría ruido de infra) y
> más de la mitad de los avisos de entregables ni siquiera llegan por el escapado de Markdown legacy. Alcance:
> silencio por defecto con tres clases de mensaje (decisión / hito / digest), un mensaje vivo por issue que se edita
> fase a fase, gramática común para avances, propuestas de mejora, bloqueos e hitos, texto plano o HTML, y
> **audio TTS obligatorio en todo mensaje** (requisito crítico de Leo). Define la gramática que la Ola Propuestas
> consume y consolida la familia de ~60 issues de avisos Telegram (hijas o cierre por grupos con OK de Leo).
> Va al final **de forma provisoria**: la posición definitiva (antes de Propuestas, para que la gramática exista
> antes de construir encima) es una decisión de reorden que Leo todavía no tomó; se ajusta cuando responda.
>
> **Ajuste 2026-09-19 (13:05 ART):** Leo aprobó el orden propuesto: la **Ola Canal del operador** pasa de la 16.ª
> a la **4.ª posición, inmediatamente antes de la Ola Propuestas** (que queda 5.ª). Motivo: la gramática común del
> canal (decisión / hito / digest, mensaje vivo por issue, audio en todo mensaje) tiene que existir antes de construir
> encima el Commander proactivo y el flujo de propuestas; si no, Propuestas nace con el formato viejo y se rehace.
> Reordenado con `reorderPlannedWaves` (identidades intactas: interna 27 → 4.ª). Todo lo que estaba entre Propuestas
> y Confiabilidad del Pulpo corre una posición hacia abajo (Confiabilidad pasa a 16.ª). Leo dejó abierta la puerta a
> volver a moverla más adelante si hace falta.
>
> **Ajuste 2026-09-19 (20:15 ART):** Leo aprobó el alcance de **#7113** (el freno humano era un falso positivo: el issue
> ya tenía las cinco firmas de definición) y sumó a la ola activa el issue **#7432** (el gate de decisión de arquitectura
> del intake escala a `needs-human` aunque el arquitecto ya firmó: invoca `gh` pelado y el Pulpo no lo tiene en el PATH).
> Segunda excepción explícita a la regla de olas acotadas, con el mismo criterio que #7371: sin el fix, cualquier issue de
> la ola con señales de decisión vuelve a frenar al operador, y el destrabe manual se revierte solo (verificado el 19/09:
> `/unblock` a las 20:15, re-bloqueo automático a las 20:16 por el mismo `ENOENT`). #7113 entró a desarrollo a las 20:21
> recién cuando salió de la fase de definición. La ola pasa a 9 issues.
>
> **Ajuste 2026-09-20 (07:54 ART):** Leo aprobó levantar los bloqueos humanos **fantasma** de **#7113** y **#7114** (a la 01:05
> el PO que validaba #7439 corrió un harness de los gates de decisión con `PIPELINE_DIR_OVERRIDE` apuntando a un tmpdir y
> #7113/#7114 como números de ejemplo; `lib/human-block.js` ignoró el override y escribió markers, órdenes de `needs-human`
> y avisos en la instalación productiva) y sumó a la ola activa el issue **#7456** (el módulo de bloqueos humanos no pasa
> por el resolvedor de ambiente ni por `write-target`, y quedó fuera del inventario de #7112). Tercera excepción explícita,
> con el criterio más fuerte de todos: es el defecto que la ola viene a cerrar, reproducido en vivo por un agente de la
> propia ola. La ola pasa a 13 issues (incluidas las tres hijas del split de #7432: #7438, #7439 y #7440).
>
> **Ajuste 2026-09-20 (12:34 ART):** Leo pidió armar una ola grande dedicada a las **estimaciones**: "la estimación del
> tiempo de finalización de cada agente es muy mala, la de la ola activa es muy mala y no tenemos estimaciones de las olas
> planificadas; que normalice, busque previsibilidad en base a la historia y la experiencia, que el margen de error se
> reduzca considerablemente y que sea conocido". Se creó el épico **#7477** y la **Ola Estimaciones previsibles** (interna 28)
> en la **17.ª posición (última), de forma provisoria**: la posición definitiva es una decisión de reorden que Leo todavía
> no tomó. Es una ola **nueva** (olas planificadas congeladas): absorbe como hijas los 12 issues abiertos dispersos sobre ETA
> (#4735, #2599, #2898, #2784, #2897, #3524, #4054, #6268, #6267, #2378, #4059, #2899) con marker canónico en el épico;
> #4737 queda en Tablero fiel, donde ya estaba. Nada cambia en la ola activa ni en las demás planificadas.
>
> **Ajuste 2026-09-20 (20:00 ART):** Leo preguntó desde cuándo hace falta un ambiente de pruebas **por proyecto** y pidió
> atar la construcción de esa feature a ese momento. Diagnóstico: el multi-proyecto real arranca en **Corte con freeze**
> (#7348), cuando el kernel en construcción pasa a ser un proyecto más de la cola junto a Intrale, y se vuelve indispensable
> en **App operadora · Base y firma** (#7349), que suma el tercero. La Ola 9.4.1 deja un ambiente singleton, no uno por
> producto. Se creó el épico **#7493** y, con OK explícito de Leo ("avanzá como propones"), la **Ola Ambiente de pruebas por
> proyecto** (interna 29) en la **10.ª posición, inmediatamente antes del Corte**; el Corte pasa a 11.ª y todo lo que sigue
> corre un lugar (Estimaciones previsibles queda 18.ª, provisoria). Ola **nueva** (olas planificadas congeladas): no se suma
> a la 9.4.1 ni a Separación.
>
> **Ajuste 2026-09-20 (15:35 ART):** Leo pidió incluir en esta misma ola el **avance de la ola que retrocede**: "cuando
> se splitea un issue el porcentaje vuelve hacia atrás, aunque el split divide el problema original en problemas más
> chicos y el total valorizado debería ser el mismo; sólo debería retroceder cuando se agrega un issue nuevo; en un
> rebote también vuelve hacia atrás y hay que ver la mejor forma de manejarlo; todo tiene que ver con todo". Se creó la
> hija **#7484** (avance monotónico salvo alta real de alcance: los splits conservan el avance ganado y los rebotes no lo
> borran; medido: 25 caídas en 24 h, 23 sin cambio de peso ni de cantidad de issues) y se sumó a la ola planificada y al
> marker canónico del épico en el mismo acto. La ola pasa a 13 hijas; su posición sigue siendo provisoria (17.ª).

| Posición | Bloque | Por qué acá | Estado |
|----------|--------|-------------|--------|
| ✅ | **Release firmado del kernel** (E1) | Sin release publicado, `consume:true` no tiene de dónde consumir. Raíz de todo. | **Hecho** — `v0.1.2` publicado y firmado |
| ✅ | **Ola 9.4 · Partir config + externalizar el estado operativo** (E2, épico #5107) | Envoltorio único de acceso al estado, migración de los accesos con guardrail, namespaceado por proyecto, partición de `config.yaml`, store durable y almacenamiento externo **preparados y ensayados en seco**. El encendido real quedó como cola (ver la Ola Encendido). | **Cerrada 16/09** (interna 10) |
| ✅ | **Ola Proveedores · Antigravity encendido y retiro de los gratuitos** (épico #6856) | Cuota adicional paga (Google vía `agy`) con round-trip real, catálogo de modelos corregido, matriz modelo×agente firmada, y baja del ruteo de los proveedores gratuitos que no editan archivos ni reportan consumo. Descomprime la cuota de Anthropic antes de las olas grandes. | **Cerrada 19/09** (interna 13) — 11/11 issues cerrados |
| **1.ª · activa** | **Ola 9.4.1 · Ambiente de pruebas del CORE** (épico #7102) | Los tests del CORE dejan de correr contra la instalación productiva: resolvedor único de ambiente y `pipelineDir` de prueba. Precondición de higiene para todo lo que sigue. **Excepción explícita (Leo, 19/09):** se sumó #7371 (alerta cuando el pin de `agy` caduca + política "versión por encima del máximo probado = advertencia"), ajeno al tema de la ola, porque sin eso cada auto-update del CLI vuelve a dejar al pipeline sin Antigravity en silencio. **Segunda excepción (Leo, 19/09 20:15):** #7432 (el gate de decisión de arquitectura del intake invoca `gh` pelado y frena con falso positivo issues ya firmados), porque frenó a #7113 y re-frena cada destrabe manual. **Tercera excepción (Leo, 20/09 07:54):** #7456 (`lib/human-block.js` ignora el resolvedor de ambiente y escribe siempre en la instalación productiva; un harness de gates corrido por el PO de #7439 dejó bloqueos fantasma en #7113 y #7114). | **Abierta 19/09** (interna 11) — 13 issues |
| **2.ª** | **Ola E8 · Contabilidad de cuota y auditor del modelo operativo** (épico #7186) | Libro contable de cuota por proveedor y auditor (#6809) que propone plan, schedule y cadena de respaldo; nada de eso se decide a mano. Con Antigravity encendido, la cuota es la variable que gobierna el paralelismo. | Planificada (interna 12) — 10 issues |
| **3.ª** | **Ola Proveedores siempre vivos · Ciclo de vida automatizado de los CLIs** (épico #7376) | Que una actualización del CLI de cualquiera de los tres proveedores nunca deje al pipeline sin proveedor y que un reset de cuota nunca se desaproveche: inventario de versión y hash con alerta única y contrato único (#7380), smoke test post-update con pin automático (#7381), actualización controlada en reposo con rollback (#7382), `resets_at` real y dispatch en el minuto del reset (#7383), la cascada prefiere la ventana fresca (#7384, necesita el libro contable de E8) y avisos de recuperación + re-verificación TOS diferida sin gatear (#7385). Generaliza #7371 (ola activa) a `claude`, `codex` y `agy`. | Planificada (interna 26) — 6 issues + épico · **creada el 19/09** |
| **4.ª** | **Ola Canal del operador · Rediseño de los avisos por Telegram** (épico #7399) | El canal de Telegram deja de ser un log de eventos del pipeline y pasa a ser el canal del operador: silencio por defecto con tres clases de mensaje (🔴 decisión / 🟢 hito / 🟡 digest), un mensaje vivo por issue que se edita fase a fase, gramática común (qué pasó / qué necesito de vos / dónde está el detalle) para avances de agentes, propuestas de mejora, bloqueos e hitos, texto plano o HTML en vez de Markdown legacy, horario silencioso y acuse de audios. **Todo mensaje va con su audio TTS completo.** Va justo antes de Propuestas para que la gramática común exista antes de construir las propuestas encima; consolida ~60 issues de avisos Telegram. Mockup con Claude Design aprobado antes de codear. | Planificada (interna 27) — épico en definición · **creada el 19/09** · **4.ª desde el 19/09** (Leo aprobó el orden propuesto) |
| **5.ª** | **Ola Propuestas · Commander proactivo y pausa de las recomendaciones** (épico #5444) | El Commander deja de ser sólo reactivo: motor de digest (#5528), catálogo de observaciones (#5529) y controles de apagado (#5530) entregan sugerencias en 3 tandas diarias, independiente del canal. Y las recomendaciones de agentes dejan de nacer como issues sueltos: modo ledger (#7361) como productor del registro único. Va después de E8 (que aporta el registro donde publicar) y de la Ola Canal del operador (que define la gramática con la que se entregan las sugerencias). Cierra el circuito completo: migración del resto de productores al registro (#6808), aceptación trazable con botón y materialización en issue (#6810) y encaje en ola + allowlist con seguimiento (#6811); dependen de #6807 y, en cadena, #6811 de #6810. | Planificada (interna 24) — 8 issues · **creada el 18/09**, cierre del circuito sumado el 18/09 |
| **6.ª** | **Ola Vault · Encendido seguro del vault de secretos** (épico #7355; el anterior #5215 cerró en la etapa del store) | Los secretos dentro del repo se pierden en cada respawn y aparecieron copiados en worktrees viejos; la **firma por botón de GATE 1 exige `vault.enabled`**. Es la cerradura que hay que poner antes de abrir el modelo operativo hacia afuera. | Planificada (interna 14) — 13 issues + épico · **subida el 18/09** (antes iba 6.ª) |
| **7.ª** | **Ola Encendido · Estado externo del modelo operativo con firma del operador** (cola de 9.4 / E2, #7194) | El encendido real de lo que 9.4 dejó preparado: flips con firma del operador en la terminal, migración con paridad, sonda positiva y ensayo de vuelta atrás. **Prerrequisito duro de la app operadora**: un celular no lee archivos locales. | Planificada (interna 16) |
| **8.ª** | **Ola Separación · Partir los skills híbridos** (Ola 9.3 / E6, épico #7027) | Grande y la **más riesgosa**: el producto puede perder reglas propias (strings, flavors, gates de QA) sin que nadie lo note. Su red de contención, el guardrail anti-regresión **#5068**, ya está cerrada. Mecanismo al kernel, contenido Intrale al adaptador. | Planificada (interna 17) — épico en definición |
| **9.ª** | **Ola Separación · Red de seguridad y launcher del corte** (E3 + E5, épico #7347) | Precondición del cutover: botón de pánico independiente del sistema que se corta, tres niveles de recuperación, snapshot con restore probado, timeout de decisión y **simulacro verde obligatorio**. Sin ensayo, no hay corte. | Planificada (interna 18) — épico en definición |
| **10.ª** | **Ola Ambiente de pruebas por proyecto · Un pipelineDir de pruebas por producto** (épico #7493) | Precondición del multi-proyecto real: generaliza el ambiente singleton de la 9.4.1 a un `pipelineDir` de pruebas aislado **por producto** (resolvedor y provisión por producto, credenciales y canales de prueba por producto, guardrail por producto, test de aislamiento cruzado A↔B↔productivo y alta por wizard que deja el ambiente listo). Va justo antes del Corte porque ahí conviven por primera vez dos proyectos reales en la cola (kernel en construcción + Intrale) y el corte exige probar contra un repo de prueba, nunca contra producción. Con un solo producto todo sigue igual. | Planificada (interna 29) — épico en definición · **creada el 20/09** |
| **11.ª** | **Ola Separación · Corte con freeze** (Ola 9.5 / E7, épico #7348) | Punto de no retorno: canary de `kernel.consume`, ventana de corte agendada y vacía (drenaje previo), el kernel pineado pasa a autoritativo y el motor embebido queda congelado como destino de rollback. | Planificada (interna 19) — épico en definición |
| **12.ª** | **Ola App operadora · Base y firma** (E9, épico #7349) | Prueba de fuego del desacople: la app nace como **proyecto nuevo operado por el pipeline** (tercer proyecto: kernel, Intrale, app). Login del operador, estado inicial y firma de gates desde el celular. Depende dura de la Ola Encendido (estado externo) y de que la separación esté hecha, para no impactar kernel y app a la vez. | Planificada (interna 20) — épico en definición |
| **13.ª** | **Ola App operadora · Operar el pipeline** (épico #7350) | Pausa total/parcial y allowlist, roadmap de olas (abrir, cerrar, reordenar con confirmación, sumar/quitar issues), issues por fase con rebotes y acciones. | Planificada (interna 21) — épico en definición |
| **14.ª** | **Ola App operadora · Equipo, proveedores y productos** (épico #7351) | Equipo y matriz modelo×agente, proveedores (cuota del libro contable, gateos, cadena de respaldo, salud multi-provider, propuestas del auditor) y productos. | Planificada (interna 22) — épico en definición |
| **15.ª** | **Ola App operadora · Métricas e historia** (épico #7352) | KPIs, costos y tokens por sesión/agente/ola, historial de eventos, DORA y velocidad, recomendaciones con gate humano y logs de agentes. Con esta ola la app cubre **toda** la funcionalidad del dashboard actual. | Planificada (interna 23) — épico en definición |
| **16.ª** | **Ola Tablero fiel · El dashboard muestra el estado real de la ola** (épico #7356) | Que lo que el operador ve coincida con el estado real de la ola, sin mezclas ni fotos viejas. Va al final del bloque de app porque el dashboard local deja de ser la superficie principal cuando la app operadora esté completa. | Planificada (interna 15) — 16 issues + épico |
| **17.ª** | **Ola Confiabilidad del Pulpo · Rebotes justos y muertes bien clasificadas** (épico #7368) | Que el pipeline distinga "el agente murió por cuota / API caída / entorno roto" de "el agente entregó código malo", y que cada rebote sea justo y único: muertes externas que no consumen el circuit breaker (#5082, #7095, #7025), contador de rebotes persistente que sólo cuenta el mismo hallazgo sin corregir (#7150, #7366), un solo rebote consolidado con todos los hallazgos de qa+tester+security+review (#7367), el watchdog no pisa veredictos (#6545, #7152), PR en conflicto vuelve al dev (#4637), la entrega no se rinde esperando la CI (#6648) y arranque sano tras un respawn (#6567, #6845). Cada ola posterior corre más barata si esto se arregla. | Planificada (interna 25) — 26 issues + épico · **creada el 18/09** |
| **18.ª** | **Ola Estimaciones previsibles · ETA de agentes, ola y roadmap con error conocido** (épico #7477) | Un único modelo de estimación para las tres capas —agente/fase, ola activa y olas planificadas del roadmap— calculado desde la historia real del pipeline (markers por fase, transiciones, velocidad por ola, rebotes, reposo de proveedores, espera del operador), con intervalo p50/p90 y **margen de error conocido y visible** junto a cada estimación, medido por backtesting contra olas cerradas y reducido de manera medible. Unifica `eta.js`, `eta-wave.js`, `mission-ola-eta.js` y el handler `wave` (#4735, #2378), percentiles por skill+fase (#2784), fases restantes con concurrencia (#2599, #2898), fuente canónica de tiempos (#2897, #3524) y estimación previa de cada ola planificada con fechas encadenadas. Va al final de forma provisoria hasta que Leo decida su posición. | Planificada (interna 28) — 13 issues + épico · **creada el 20/09** · **#7484 sumada el 20/09 15:35** |

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
