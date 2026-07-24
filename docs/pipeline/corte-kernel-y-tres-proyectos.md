# Corte del kernel, kernel como proyecto vivo y los tres proyectos en paralelo

> **Estado:** definición viva — surge de la conversación con Leo del **2026-07-24**.
> **Naturaleza:** documento de **encuadre y refinamiento**. No hay código nuevo asociado ni
> issues creados: las épicas de la §7 están **sugeridas, no creadas** (decisión explícita de Leo:
> "sugerí las épicas pero no las crees por el momento").
> **No redefine** la frontera kernel↔adaptador (Ola 8) ni la secuencia de migración (Ola 9):
> la **consume** y la completa en los dos puntos que faltaban — el **kernel como proyecto vivo con
> instancia productiva y en construcción**, y la **continuidad operativa / rollback del corte**.

## Cómo leer este documento

| Sección | Responde a |
|---------|-----------|
| 1. Los tres proyectos en paralelo | qué convive con qué cuando termine el corte |
| 2. Dónde estamos parados hoy (verificado) | qué está hecho de verdad y qué falta |
| 3. Cómo se ejecuta el corte | secuencia del cutover, paso por paso |
| 4. El kernel como proyecto vivo (prod ↔ construcción) | cómo el kernel se desarrolla a sí mismo sin morderse la cola |
| 5. **Continuidad operativa y rollback del corte** | qué hacemos si al cortar nos quedamos sin operación |
| 6. Lo que todavía no estamos mirando | riesgos y piezas faltantes detectadas en el refinamiento |
| 7. Épicas sugeridas (NO creadas) | qué habría que abrir cuando se decida arrancar |

**Documentos que este encuadre consume (no duplica):**
[`kernel-coexistencia.md`](kernel-coexistencia.md) (etapas E0–E4, aislamiento, rollback de etapa) ·
[`kernel-updates.md`](kernel-updates.md) (versionado, distribución firmada, auto-hospedaje híbrido) ·
[`ola9-sub-olas-migracion.md`](ola9-sub-olas-migracion.md) (sub-olas 9.1–9.5) ·
[`kernel-cutover-9.1.md`](kernel-cutover-9.1.md) (wiring actual, pin, `consume:false`) ·
[`ola-puente-kernel-multiproducto.md`](ola-puente-kernel-multiproducto.md) (descriptor, supervisor,
ejecución paralela, cloud-ready) · [`contrato-kernel-adaptador.md`](contrato-kernel-adaptador.md).

---

## 1. Los tres proyectos en paralelo

El objetivo final no es "sacar el kernel de Intrale". Es llegar a **tres proyectos independientes que
conviven**, todos operados por el mismo modelo operativo:

| Proyecto | Qué es | Rol frente al kernel |
|----------|--------|----------------------|
| **Kernel operativo** (`Intrale/kernel`) | El modelo operativo genérico: motor, ciclo de vida, gates, skills de proceso. | Es **el ejecutor** y, a la vez, **un proyecto más** que el ejecutor atiende (§4). |
| **Intrale** (`intrale/platform`) | El producto de negocio (backend Ktor + app Compose). Hoy tiene el kernel embebido. | Es un **adaptador**: declara su manifiesto, pinea una versión del kernel y aporta lo específico del stack. |
| **App operadora móvil** | La consola móvil para gestionar el modelo operativo y los N proyectos. | Es **otro adaptador** más, y el primer producto que nace ya desacoplado. Consume la API remota del kernel. |

**La consecuencia conceptual importante:** el kernel deja de ser "la infraestructura de Intrale" y pasa
a ser un producto con sus propios usuarios (los tres proyectos). Intrale se vuelve *un* cliente, no *el*
cliente. Y la app operadora es la prueba de fuego del desacople: si el kernel no puede dar de alta y
operar un proyecto que no es Intrale, el corte no está terminado.

**Dependencia dura a tener presente:** la app operadora **no puede existir** mientras el estado del
modelo operativo viva en el filesystem de esta máquina — una app móvil no lee archivos locales. El
orden real es: estado externalizado y accesible por API → recién ahí la app. Ver
[`externalizacion-estado-operativo-remoto.md`](externalizacion-estado-operativo-remoto.md).

---

## 2. Dónde estamos parados hoy (verificado 2026-07-24)

**Hecho:**

- El **repo del kernel existe** (`Intrale/kernel`) con `contracts/`, `core/`, `lib/`, `hooks/`,
  `fixtures/`, `skills/`, y hay checkout local.
- El producto tiene su **manifiesto de adaptador** (`pipeline.config.json`): `projectId`,
  `contractVersion`, `capabilities`, y el bloque `kernel` con **pin exacto** + política de firma
  (sigstore/cosign OIDC keyless) e integridad SRI.
- La **Ola Puente está cerrada entera**: self-hosting, rol dev genérico, descriptor de proyecto,
  persistencia durable, supervisor de N productos, ejecución paralela, gestión desde interfaz, firma
  por producto.
- La **ola en curso (#8)** es el alta de un producto nuevo desde el dashboard: la puerta de entrada
  para dar de alta el 2.º y 3.er proyecto.

**Lo que todavía NO pasó (el nudo real):**

- `kernel.consume` está en **`false`**. El motor que corre en producción sigue siendo el **embebido**
  en el repo del producto. Eso es **coexistencia, no cutover**.
- **No hay ningún release publicado** en `Intrale/kernel` (verificado: la lista de releases está
  vacía). Sin release firmado, `consume:true` no tiene de dónde consumir.
- El **estado sigue plano y global** (sub-ola 9.4 pendiente): mientras no esté namespaceado por
  proyecto, dos proyectos no pueden correr sin pisarse.

En una frase: **la capacidad está construida pero no ejercida.** Falta cortar el cordón, y lo que
falta no es diseño — es una secuencia de ejecución con red de seguridad.

---

## 3. Cómo se ejecuta el corte

Secuencia mínima, en orden de dependencia. Cada paso deja el producto funcionando o revertible en
minutos (principio de la Ola 9: batch chico), y **cada uno termina con OK humano**.

1. **Publicar el release firmado del kernel** (`v0.1.0`): semver exacto + firma cosign + checksum.
   Es el **único paso que requiere mano humana sí o sí** (token `write:packages` + 2FA + firma). Es un
   gate fail-closed por diseño, no un olvido. Sin esto, nada más avanza.
2. **Mudar los skills de orquestación** (sub-ola 9.2): los puros de proceso van enteros al kernel.
3. **Partir los skills híbridos** (9.3): mecanismo → kernel, contenido de negocio → adaptador.
4. **Partir la config y externalizar el estado** (9.4), namespaceado por proyecto. **Éste es el paso
   que hoy falta y el que habilita todo lo demás** (multi-proyecto real y app móvil).
5. **Encender el consumo en canary**: `kernel.consume:true` sobre un subset reversible, con el motor
   local todavía vivo y congelado como destino de rollback.
6. **Freeze + corte** (9.5): drenar el trabajo en vuelo, congelar el motor local, el kernel pasa a
   autoritativo. Ventana **acotada y agendada**, no "cuando salga".
7. **Observación post-corte y archivado** del motor local (no borrado) recién cuando el corte esté
   estable.

**Invariante de los pasos 1–5:** en cualquier momento, apagar el consumo del kernel devuelve el
sistema al motor local sin pérdida. El punto de no-retorno es el 6.

---

## 4. El kernel como proyecto vivo: instancia productiva ↔ instancia en construcción

Éste es el punto que Leo planteó y que la documentación previa sólo cubría de costado (auto-hospedaje
híbrido, [`kernel-updates.md`](kernel-updates.md) §5). Acá se explicita el modelo de ejecución.

### 4.1 Dos instancias, nunca una

| Instancia | Qué es | Qué puede hacer |
|-----------|--------|------------------|
| **KERNEL-PROD** | Una versión **pinneada, firmada e inmutable**, instalada y **en ejecución**. Es la que opera los tres proyectos. | Ejecuta trabajo. **No se modifica a sí misma. No se auto-actualiza.** |
| **KERNEL-BUILD** | El **working copy** del repo del kernel: la versión en construcción. Es un proyecto más en la cola, tratado como cualquier producto. | Se edita, se testea, se revisa, se mergea. **Nunca opera producción.** |

**Regla de oro (no negociable):** *la instancia que ejecuta nunca es la instancia que se está
modificando*. Es exactamente el patrón **stage0 pinned** ya definido: el validador de una update corre
sobre la versión anterior, congelada, y la update bajo evaluación **no puede tocar sus propios gates**.

Esto responde literalmente al planteo: **sí, el kernel es un proyecto que se modifica como Intrale o
como la app móvil — pero el que ejecuta esa modificación es una versión productiva distinta de la que
se está modificando.**

### 4.2 El ciclo de vida de un cambio en el kernel

```
issue en Intrale/kernel
   → KERNEL-PROD lo toma como proyecto "kernel" (rol dev genérico)
   → el agente trabaja sobre KERNEL-BUILD (working copy aislado)
   → tests y QA contra el repo FIXTURE, nunca contra producción
   → PR + review + gates
   → release firmado (semver + cosign + checksum)
   → 🔴 gate humano fuera de banda — no auto-promovible
   → bump del pin en cada adaptador, escalonado y con canary por producto
   → swap de KERNEL-PROD a la versión nueva + smoke test
   → verde: queda. rojo: rollback automático al pin anterior (§5)
```

**Ningún automatismo puede promover una update del kernel a producción.** El trabajo de producto sí
corre en auto-hospedaje pleno (dogfooding): un cambio en Intrale no se auto-modifica, así que ahí no hay
lazo peligroso. Se aísla **lo que se auto-modifica**, no todo.

### 4.3 Quién hace el swap (la pieza que faltaba nombrar)

Un proceso **no puede reemplazarse a sí mismo mientras ejecuta**. El swap de KERNEL-PROD lo tiene que
hacer un componente externo y mínimo:

- Un **launcher/updater** chiquito, estable, que **cambia poco y no viaja con el kernel**: baja la
  versión nueva, verifica firma y checksum, para el kernel viejo, arranca el nuevo, corre el smoke y
  decide quedarse o volver.
- Ese launcher tiene que sobrevivir al reinicio del kernel. La primitiva ya existe hoy: el **watchdog
  externo** que el sistema operativo dispara solo, independiente del pipeline.
- **Cuanto más chico y más estable el launcher, mejor**: es el único componente que no tiene red de
  seguridad, porque es *él* la red de seguridad.

### 4.4 Aislamiento entre las dos instancias

- **Árboles de estado separados.** KERNEL-BUILD nunca escribe en el estado de KERNEL-PROD, ni al revés.
- **Credenciales separadas.** KERNEL-BUILD no debe tener permisos de escritura sobre producción
  (deploy, merge a `main` del producto, mutación del estado operativo).
- **Contención de recursos.** Las dos instancias compiten por la misma máquina: entran al mismo
  scheduler de ventanas autoexcluyentes, como un consumidor más.

---

## 5. Continuidad operativa y rollback del corte

> Planteo de Leo: *"no hablaste de una instancia de rollback para el caso de que cuando hagamos el
> corte nos quedemos sin operación"*. Tiene razón: lo documentado hasta acá es el rollback **por
> etapa** (tabla de fallos de [`kernel-coexistencia.md`](kernel-coexistencia.md) §7). Lo que faltaba es
> el caso duro: **el corte sale mal y nos quedamos sin modelo operativo funcionando.**

### 5.1 Principio rector

**El mecanismo de rollback no puede depender del sistema que se está cortando.** Si el rollback
necesita que el kernel arranque, que el dashboard responda o que el bot conteste, entonces no es un
rollback: es una función más del sistema caído. Todo lo de abajo se diseña contra ese principio.

### 5.2 Los tres niveles de recuperación

| Nivel | Cuándo | Qué se hace | Quién/qué lo dispara |
|-------|--------|-------------|----------------------|
| **N1 · Apagar el consumo** | El kernel arranca pero se comporta mal (decisiones raras, issues trabados). | Volver el consumo a apagado: el motor local congelado retoma. Cambio de un flag + reinicio. | Operador o automatismo de smoke. Segundos. |
| **N2 · Rollback atómico al punto congelado** | El kernel no arranca, o el primer lote post-corte falla. | Restaurar el motor local desde el tag de retorno y relanzar, reusando las primitivas de rollback que ya existen (corren **detached**, sobreviven a la muerte del proceso que las lanzó). | Watchdog externo o comando único del operador. Minutos. |
| **N3 · Reconstrucción desde snapshot** | El rollback también falla (código *y* estado dañados). | Restaurar el árbol de estado desde el snapshot pre-corte verificado por checksum + checkout del tag estable en una copia limpia. | Operador, manual, con guía escrita paso a paso. |

**Precondición de los tres niveles:** el motor local **se congela, no se archiva ni se borra**, hasta
que el corte esté estable y observado. El destino del rollback tiene que estar vivo.

### 5.3 El botón de pánico

- **Un solo comando**, ejecutable desde una terminal cualquiera, sin depender de Telegram, del
  dashboard, ni del kernel. Documentado literal (copiable) en el runbook del corte.
- **Vía de aviso independiente:** si el canal de notificación viaja dentro del pipeline caído, el
  operador no se entera de nada. El aviso de "se disparó el rollback" tiene que poder salir por un
  camino que no dependa del sistema que falló.
- **Mensaje inequívoco:** qué etapa falló, qué versión del kernel estaba en juego, qué se restauró y
  cómo confirmar que quedó bien. Nada de volcado técnico crudo.

### 5.4 El problema real no es el código: es el estado

Volver el código atrás es fácil. Lo difícil es qué pasa con **lo que avanzó** durante la ventana del
corte (issues que cambiaron de fase, firmas, métricas). Dos decisiones que evitan el lío:

1. **Ventana de corte sin trabajo en vuelo.** Se **drena** todo antes del freeze: no se corta a la
   mitad de nada. Si durante la ventana no avanza trabajo, no hay estado que reconciliar y el rollback
   es limpio por construcción. **Ésta es la política preferida: ventana corta y vacía.**
2. **Journal append-only de la ventana.** Para lo poco que sí ocurra, registrar los cambios de estado
   del período en un log re-aplicable, de modo que volver atrás no signifique perder el avance.
3. **Snapshot verificado por checksum** del estado inmediatamente antes del corte, con **restore
   probado** (no "existe el backup": *se restauró y funcionó*).

### 5.5 Cómo se decide, y en cuánto tiempo

- **Criterio de éxito declarado ANTES del corte**, no improvisado después: smoke en verde + el primer
  lote de trabajo completa su ciclo por el kernel.
- **Timeout de decisión.** Si a los N minutos no hay verde, **se vuelve atrás**: no se espera "a ver si
  se acomoda". Fail-closed hacia el último estado conocido bueno, coherente con el resto del modelo.
- **Un solo responsable de la decisión** durante la ventana, con criterio escrito. Nadie más toca.

### 5.6 El rollback no ensayado no existe

**Gate propuesto: sin ensayo verde, no hay corte.** Antes del corte real se hace un **simulacro**:

- Se ejecuta el rollback completo en frío y **se mide cuánto tarda** (eso fija el tiempo de
  recuperación real, y si no es aceptable, se arregla antes y no durante el incidente).
- Se verifica que el sistema restaurado **funciona de verdad** (smoke), no que "el script terminó sin
  error".
- Se repite el simulacro en cada sub-ola que mueva archivos entre repos, porque el rollback envejece
  igual que el código.

### 5.7 Modo degradado: seguir operando sin modelo operativo

Aunque el rollback funcione, conviene tener escrito el **piso mínimo**: cómo se sigue trabajando si el
pipeline no está disponible por un rato largo.

- Desarrollo **manual asistido** sobre el repo, con las convenciones de ramas/PR/QA de siempre. Se
  pierde automatización, **no** se pierde la capacidad de entregar.
- Los **gates de calidad no se relajan** en modo degradado: se ejecutan a mano. El modo degradado es
  una pérdida de velocidad, nunca una excusa para mergear sin QA.
- Que esto esté escrito de antemano evita la peor decisión posible: aflojar los gates bajo presión.

---

## 6. Lo que todavía no estamos mirando

Refinamiento propio, más allá del rollback. Ordenado por lo que más duele si no se atiende.

1. **Punto único de falla: la máquina.** Los tres proyectos corren en una sola PC. Con el corte, el
   blast radius se triplica: si se cae, se caen los tres. El diseño cloud-ready ya está pensado en la
   Ola Puente, pero sigue sin ejercerse.
2. **Presupuesto de cuota compartido.** La cuota de los proveedores es global. Con tres proyectos, uno
   puede comerse la cuota de los otros dos sin que nadie lo note. Hace falta **cuota y prioridad por
   proyecto**, no sólo por agente.
3. **Bootstrap frío / recuperación total.** ¿Cómo se levanta todo desde cero en una máquina nueva? Hoy
   ese procedimiento no está escrito. Es el mismo problema del rollback, un nivel más arriba.
4. **Backup del estado durable.** Cuando el estado salga del filesystem, hace falta export periódico +
   **restore probado**. Un store remoto sin backup verificado es un punto único de falla nuevo,
   disfrazado de mejora.
5. **Permisos por proyecto.** Un token único con acceso a todos los repos convierte cualquier
   compromiso en un compromiso total. Credenciales scopeadas por proyecto.
6. **Deriva del adaptador.** Al partir los skills híbridos, el riesgo silencioso es que el producto
   pierda reglas propias (strings, flavors, gates de QA). Hace falta un **test de no-regresión del
   adaptador** que falle si una regla del producto se evaporó en la mudanza.
7. **Evolución del contrato con tres consumidores.** Hoy cambiar el contrato rompe una cosa; mañana
   rompe tres. Política de deprecación explícita: soportar la versión actual y la anterior, con aviso.
8. **El operador como cuello de botella.** El modelo depende de gates humanos, y con tres proyectos las
   firmas se triplican. O se agrupan/delegan de forma controlada, o el gate humano pasa de ser una
   protección a ser el freno principal.
9. **Observabilidad multi-proyecto.** El anti cross-talk ya está definido (se ve de qué proyecto habla
   cada mensaje), pero falta la vista agregada: cuál de los tres está frenado, cuál consume, de quién
   fue el incidente.
10. **Higiene del repo del kernel.** Si alguna vez se abre o se comparte, no puede arrastrar nada de
    Intrale: el escaneo de secretos como gate de publicación ya está definido, pero conviene sumar
    licencia y política de visibilidad antes de que haya terceros mirando.

---

## 7. Épicas sugeridas — **NO crear todavía**

> Decisión explícita de Leo (2026-07-24): **sugerir, no crear**. Esta tabla es el borrador para cuando
> se confirme el arranque; en ese momento se crean vía `/planner split`, no a mano.

| # | Épica sugerida | Alcance | Tamaño | Depende de |
|---|----------------|---------|--------|------------|
| E1 | **Release firmado del kernel v0.1.0** | Publicar el primer release semver firmado + checksum; deja el pin del adaptador consumible. Requiere mano humana. | Simple | — (es la raíz) |
| E2 | **Externalizar config + estado por proyecto** (sub-ola 9.4) | Partir `config.yaml`, namespacear el estado por proyecto, dejarlo accesible fuera de la máquina. **Habilita multi-proyecto real y la app móvil.** | Grande | E1 |
| E3 | **Red de seguridad del corte: rollback + simulacro** | Botón de pánico independiente, snapshot verificado, timeout de decisión, aviso por vía alternativa y **simulacro obligatorio** como gate previo. | Medio | E1 |
| E4 | **Runbook de continuidad y modo degradado** | Cómo se opera si el modelo operativo no está disponible; bootstrap frío en máquina nueva; gates que no se relajan. | Simple | E3 |
| E5 | **Launcher/updater externo del kernel** | Componente mínimo y estable que hace el swap de versión productiva, verifica firma, corre smoke y revierte solo. | Medio | E1, E3 |
| E6 | **Mudanza de skills (orquestación + híbridos)** | Sub-olas 9.2 y 9.3, con **test de no-regresión del adaptador** como criterio de aceptación. | Grande | E2 |
| E7 | **Corte con freeze + observación** (sub-ola 9.5) | Ventana acotada, drenaje, consumo encendido, motor local congelado, observación post-corte. | Medio | E2, E3, E5, E6 |
| E8 | **Cuota y prioridad por proyecto** | Que un proyecto no le consuma la cuota a los otros; presupuesto y prioridad por proyecto. | Medio | E2 |
| E9 | **App operadora móvil (proyecto nuevo)** | Alta como tercer proyecto vía el wizard, consumiendo la API del estado remoto. Es la prueba de fuego del desacople. | Grande | E2, E7 |

**Camino crítico:** `E1 → E2 → (E3, E5) → E6 → E7 → E9`. Todo lo demás es paralelizable.

---

## Referencias

- [`kernel-coexistencia.md`](kernel-coexistencia.md) — etapas E0–E4, aislamiento, rollback por etapa.
- [`kernel-updates.md`](kernel-updates.md) — versionado, distribución firmada, decisión de auto-hospedaje híbrido.
- [`ola9-sub-olas-migracion.md`](ola9-sub-olas-migracion.md) — sub-olas 9.1–9.5 y gates entre ellas.
- [`kernel-cutover-9.1.md`](kernel-cutover-9.1.md) — wiring vigente, pin y `consume:false`.
- [`ola-puente-kernel-multiproducto.md`](ola-puente-kernel-multiproducto.md) — descriptor, supervisor multi-producto, ejecución paralela, cloud-ready.
- [`externalizacion-estado-operativo-remoto.md`](externalizacion-estado-operativo-remoto.md) — estado remoto (dependencia dura de la app móvil).
- [`contrato-kernel-adaptador.md`](contrato-kernel-adaptador.md) — puertos, manifiesto, `contractVersion`.
