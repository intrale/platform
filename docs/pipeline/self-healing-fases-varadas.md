# Self-healing de fases varadas — operación y salida del bloqueo

> Contexto: #4614 (reconciler original), #4222 (guarda anti bloqueo fantasma),
> #5060 (ejecución sólo por olas), **#5396** (fin del re-escalado en loop),
> **#6150** (el aviso lo gobierna la tarea frenada, no la racha).
> Código: `.pipeline/lib/stuck-phase-detector.js`,
> `.pipeline/lib/stuck-phase-reconciler.js`,
> `.pipeline/lib/stuck-phase-reconciler-runner.js`,
> `.pipeline/lib/stuck-reconciler-deps.js`,
> `.pipeline/lib/stuck-reconciler-copy.js`.

## Qué hace

Cada 10 minutos el Pulpo corre un tick que busca **fases paralelas varadas** de
`desarrollo` (`validacion`, `verificacion`, `aprobacion`): issues cuyos
deliverables quedaron a medias y sin ningún agente vivo trabajando.

Ante una fase varada sólo puede hacer dos cosas:

- **re-encolar** el skill que falta (vuelve a correr el agente), o
- **escalar a un humano** (`needs-human` + notificación de Telegram).

> **Línea roja.** El reconciler **nunca** resuelve la ambigüedad por su cuenta.
> Jamás escribe `resultado: aprobado`. Ante duda: humano. Y si no se le puede
> avisar, queda ruidoso en el log — nunca silencioso.

## Cuándo NO escala (las cuatro causas de silencio)

`#5396` acotó a quién se le avisa. Un tick puede terminar sin notificar nada por
cuatro motivos distintos, y **el log los distingue**:

| Causa | Razón en el log | Qué significa |
|---|---|---|
| `ola` | `fuera-de-allowlist (backlog dormido, no tocar)` | El issue no está en la ola vigente. Residuo de olas viejas: se audita, no se toca. |
| `cache` | `cache-desconocida` | No hay entrada fresca del issue en `.issue-title-cache.json`. **Fail-closed**: ante la duda, callarse. |
| `dedupe` | `ya-escalado (dedupe: marker\|cola\|cache-label)` | Ya se escaló antes. El sufijo dice de dónde salió la evidencia. |
| `cerrado` | `issue-cerrado-o-inactivo (residuo, no tocar)` | El issue está CLOSED en GitHub. |

El filtro de ola aplica **siempre**, no sólo bajo pausa parcial. La política es
la canónica de `partialPause.isIssueAllowedInState()`:

- `running` → deniega todo (sin allowlist no hay ola que acote el barrido, #5060);
- `paused` → deniega todo;
- `partial_pause` → sólo los issues de `allowedIssues`.

### Precedencia del dedupe

`hasNeedsHuman()` devuelve el **origen** de la supresión, en este orden:

1. **`marker`** — archivo en `<pipeline>/<fase>/bloqueado-humano/<issue>.<skill>`.
   Es la **fuente de verdad**.
2. **`cola`** — orden de label todavía sin drenar en `servicios/github/pendiente/`.
3. **`cache-label`** — entrada **fresca** del title-cache que ya trae `needs-human`.
4. **`cache-desconocida`** — entrada ausente o vencida según
   `title-cache-freshness.needsRefetch()` → **no re-escalar**.

El title-cache es un **hint, nunca autoridad**: sólo puede suprimir de más, jamás
habilitar un escalado.

## Observabilidad: cómo saber que sigue vivo

El riesgo de este diseño es obvio: tres silencios legítimos compuestos
(fail-closed por caché + filtro de ola + allowlist vacía entre olas) dejan el
self-healing **100% mudo por diseño**, y nadie se entera. Por eso:

- **Todos** los ticks loguean el agregado, hubo acción o no:

  ```
  [reconciler] 🔧 self-healing tick: {"evaluados":7,"suprimidos_por_ola":4,
    "suprimidos_por_cache":2,"suprimidos_por_dedupe":1,"escalados":0,"requeued":0}
  ```

- **Qué se notifica lo decide el conjunto de tareas realmente frenadas**, no la
  racha. Cada decisión del tick se clasifica **una por una** (`isRealRisk` en
  `lib/stuck-reconciler-copy.js`) y sólo entra la que quedó **fail-closed por
  estado no confirmado**: el reconciler quiso actuar y no pudo confirmar el
  estado de la tarea. Conjunto vacío ⇒ silencio, por más ciclos que lleve.
  Conjunto no vacío ⇒ **se avisa en el primer ciclo del episodio**, sin esperar
  ninguna racha.
- **Un aviso por episodio.** El episodio se identifica por la huella
  `issue|fase|motivo` de las tareas frenadas (`buildEpisodeFingerprint`): si el
  conjunto **cambia** — entra o sale una tarea — es un episodio nuevo y se
  vuelve a avisar; si es **idéntico**, se calla. Conjunto vacío cierra el
  episodio, y uno posterior vuelve a avisar.
  Ya **no** existe el criterio agregado del filtro de ola
  (`suprimidos_por_ola == evaluados`): comparar contadores escondía la única
  tarea que importaba entre cientos de decisiones sanas — y al revés, llegó a
  disparar un aviso con 177 decisiones y **cero** tareas frenadas.
- La racha **sobrevive como dato de diagnóstico** (CA-7 de #5396), ya no
  gobierna el envío: se loguea y se persiste como
  `ciclos_revisando_sin_actuar` en `.pipeline/.stuck-reconciler-health.json`,
  junto con `umbral_ciclos`, `tareas_en_riesgo`, `episodio`, `ultimo_aviso_iso`
  y `motivos`. Ese archivo sigue separado de `.stuck-reconciler-state.json`,
  que está indexado por `issue|fase`.
- Los contadores por tick van al **log**, no a Telegram. Sólo el aviso de tareas
  frenadas notifica, y sin audio TTS (el audio queda reservado al circuit
  breaker).

Para auditar a mano:

```bash
grep 'self-healing tick' .pipeline/logs/pulpo.log | tail -20
cat .pipeline/.stuck-reconciler-health.json
```

## Salida operativa del bloqueo (CA-9 · riesgo #4/#5.3)

Cuando el reconciler escala, `humanBlock.reportHumanBlock()` deja:

- el **marker** `<pipeline>/<fase>/bloqueado-humano/<issue>.<skill>`,
- su metadata `<marker>.reason.json` (motivo, pregunta, precondición),
- una orden de label `needs-human` en la cola del servicio-github,
- una notificación de Telegram **con botones de acción rápida**.

> El marker se planta con `moveFromActive: false` y `pipeline` explícito: el
> deliverable de `listo/` **no se mueve**. Esa evidencia es lo que el detector
> usa para decidir; moverla rompería el diagnóstico.

### Qué `<skill>` lleva el marker (y por qué importa)

El `<skill>` **no** es un nombre sintético: sale de los skills reales que
motivaron la escalación y se valida contra `skills_por_fase[fase]` —
exactamente la misma lista que usa el INVARIANTE de dispatch de `pulpo.js`.

| Caso | `<skill>` elegido |
|---|---|
| Ambigüedad (`rechazado` / `cancelado` / ilegible) | El primer skill ambiguo de la fase (`tester`, `qa`, …) |
| Tope de reintentos del carril `requeue` | El primer skill que agotó los reintentos |
| `estado indeterminado` (no imputa skill) | Fallback determinista: primer skill de `skills_por_fase[fase]` |
| La fase no declara `skills_por_fase` | **No se escala** (fail-closed) + log `sin skills_por_fase` |

La procedencia self-healing viaja en el `reason`, con prefijo `[self-healing]`.

> **Por qué no un skill sintético.** Una versión previa plantaba
> `<issue>.reconciler`. Ese nombre no existe en `skills_por_fase`, así que al
> destrabar el work-item entraba al despacho y el invariante skill∈fase lo
> rebotaba a `pendiente/` **sin registrar cooldown**, emitiendo un Telegram
> `⛔ Pipeline bloqueó lanzamiento de reconciler:#N` en **cada tick**. O sea: la
> vía de salida del bloqueo generaba justo el spam que este mecanismo elimina.
> Con un skill real, destrabar re-corre el agente que quedó sin veredicto.

**El `needs-human` tiene dos dueños** (`escalate` lo pone, `servicio-reconciler`
lo saca), y por eso importa quién lo quita y cuándo:

| Vía | Quién la dispara | Efecto concreto al destrabar |
|---|---|---|
| Botones de la notificación (`buildBlockedActionMarkup`) | El operador, desde Telegram | `executeQuickAction` → `reactivateAllBlocked` → `unblockIssue` (misma mecánica que la fila siguiente). |
| `humanBlock.unblockIssue({ issue, guidance, unlocker })` | Operador / brazo de desbloqueo | **`rename`** del marker a `<pipeline>/<fase>/pendiente/<issue>.<skill>` + `<marker>.guidance.txt` con la guía, y borra el `.reason.json`. El Pulpo lo despacha en el tick siguiente: el `<skill>` está en `skills_por_fase[fase]`, así que **pasa el invariante** y el agente re-corre. |
| `humanBlock.dismissBlockedIssue({ issue })` | Operador | Borra marker + `.reason.json`. **No** reactiva: el issue no vuelve a la cola. |
| Archivado por TTL del servicio-reconciler (#3186) | Automático | Poda markers vencidos. |
| `reconcileLabelToFilesystem` (#4222) | Automático | **Sólo si NO hay marker**: limpia labels `needs-human` fantasma. |

> El `.guidance.txt` que deja `unblockIssue` **no** se despacha como work-item:
> `listWorkFiles` lo filtra vía `isMarkerArtifact` (`pulpo.js:1548-1554`).

> **Mientras el work-item destrabado está en `pendiente/`, el reconciler no lo
> vuelve a tocar**: el runner lo cuenta como `liveSkills`, el detector devuelve
> `trabajo-vivo` y la decisión es `none`. No hay ventana de doble escalado.

Mientras el marker exista, `reconcileLabelToFilesystem` **saltea** el issue
(`blockedByIssue.has(...) → continue`) y no encola `remove-label`. Ése es el
mecanismo que cortó la oscilación add/remove que se veía en `svc-github.log`
como el par `Label "needs-human" → #N` / `removido de #N` cada ~30 s.

> **El bloqueo también frena el re-encolado.** `bloqueado-humano/` no es ni
> deliverable-state ni live-state para el runner, y el marker se planta sin
> mover el deliverable de `listo/`: el issue **se sigue evaluando** en cada
> tick. Por eso el guard de dedupe cubre los dos carriles, no sólo `escalate`
> — un issue con bloqueo vigente decide `none` con razón
> `bloqueado-humano (dedupe: <origen>)` en lugar de re-encolar el skill que
> falta. Sin eso, el reconciler spawnearía un agente encima de un issue que
> está esperando decisión humana, que es exactamente lo que la línea roja
> ("ante duda: humano") prohíbe.

Sin una de estas vías, el marker acumula bloqueo sin salida. Si ves un issue
bloqueado que ya no corresponde:

```bash
# ver todos los bloqueos vivos
node -e "console.log(require('./.pipeline/lib/human-block').listBlockedIssues())"
```

## El defecto que esto arregla (#5396)

Antes, el operador recibía cada 10 minutos escalaciones de issues de julio que
no estaba mirando: **36 notificaciones para 8 decisiones reales (78% de ruido)**,
y de 25 issues escalados sólo 3 eran de la ola activa. Tres causas:

1. **El dedupe miraba señales transitorias.** Cola de GitHub drenada → el guard
   se apagaba → mismo issue re-escalado en cada tick.
2. **El filtro de ola sólo aplicaba bajo pausa parcial.** Fuera de pausa barría
   todo el backlog histórico. Peor: el lambda leía `ppMode.allowed_issues`
   (snake) sobre un objeto normalizado a `allowedIssues` (camel), así que
   *durante* la ola denegaba **todos** los issues — la alarma estaba muerta justo
   cuando hacía falta.
3. **El escalado no plantaba el marker**, sólo encolaba el label → el otro
   reconciler lo veía como fantasma y lo borraba ~30 s después.

## Tests

```bash
node --test .pipeline/lib/stuck-phase-reconciler*.test.js
node --test .pipeline/__tests__/stuck-reconciler-wiring-5396.test.js
node --test .pipeline/lib/stuck-reconciler-copy.test.js
node --test .pipeline/lib/__tests__/stuck-escalate-no-oscilacion-5396.test.js
node --test .pipeline/lib/__tests__/servicio-reconciler.test.js
```

`stuck-reconciler-wiring-5396.test.js` es el importante: verifica la **política
real** de `buildStuckReconcilerDeps` (no un `allowed: true` mockeado). El objeto
`deps` se extrajo de `pulpo.js` a `lib/stuck-reconciler-deps.js` justamente para
que ese test sea posible sin cargar 16k líneas con side-effects.
