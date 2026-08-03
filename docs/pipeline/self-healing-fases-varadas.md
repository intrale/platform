# Self-healing de fases varadas — operación y salida del bloqueo

> Contexto: #4614 (reconciler original), #4222 (guarda anti bloqueo fantasma),
> #5060 (ejecución sólo por olas), **#5396** (fin del re-escalado en loop).
> Código: `.pipeline/lib/stuck-phase-detector.js`,
> `.pipeline/lib/stuck-phase-reconciler.js`,
> `.pipeline/lib/stuck-phase-reconciler-runner.js`,
> `.pipeline/lib/stuck-reconciler-deps.js`.

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

- Si hay **6 ticks consecutivos** (≈1 h) con `evaluados > 0` y cero acciones, se
  manda **una sola** notificación de señal de vida. La racha vive en
  `.pipeline/.stuck-reconciler-health.json` (separado de
  `.stuck-reconciler-state.json`, que está indexado por `issue|fase`).
- **No** se emite esa señal si el silencio se explica 100% por el filtro de ola
  (`suprimidos_por_ola == evaluados`): acotar a la ola es lo correcto, no una
  anomalía.
- Los contadores por tick van al **log**, no a Telegram. Sólo la señal de vida
  notifica, y sin audio TTS (el audio queda reservado al circuit breaker).

Para auditar a mano:

```bash
grep 'self-healing tick' .pipeline/logs/pulpo.log | tail -20
cat .pipeline/.stuck-reconciler-health.json
```

## Salida operativa del bloqueo (CA-9 · riesgo #4/#5.3)

Cuando el reconciler escala, `humanBlock.reportHumanBlock()` deja:

- el **marker** `<pipeline>/<fase>/bloqueado-humano/<issue>.reconciler`,
- su metadata `<marker>.reason.json` (motivo, pregunta, precondición),
- una orden de label `needs-human` en la cola del servicio-github,
- una notificación de Telegram **con botones de acción rápida**.

> El marker se planta con `moveFromActive: false` y `pipeline` explícito: el
> deliverable de `listo/` **no se mueve**. Esa evidencia es lo que el detector
> usa para decidir; moverla rompería el diagnóstico.

**El `needs-human` tiene dos dueños** (`escalate` lo pone, `servicio-reconciler`
lo saca), y por eso importa quién lo quita y cuándo:

| Vía | Quién la dispara | Efecto |
|---|---|---|
| Botones de la notificación (`buildBlockedActionMarkup`) | El operador, desde Telegram | Resuelve el bloqueo por el handler de quick-actions. |
| `humanBlock.unblockIssue({ issue, guidance, unlocker })` | Operador / brazo de desbloqueo | Reactiva el work-item con la guía del humano. |
| `humanBlock.dismissBlockedIssue({ issue })` | Operador | Descarta el bloqueo sin reactivar (el issue no va más). |
| Archivado por TTL del servicio-reconciler (#3186) | Automático | Poda markers vencidos. |
| `reconcileLabelToFilesystem` (#4222) | Automático | **Sólo si NO hay marker**: limpia labels `needs-human` fantasma. |

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
node --test .pipeline/lib/__tests__/stuck-escalate-no-oscilacion-5396.test.js
node --test .pipeline/lib/__tests__/servicio-reconciler.test.js
```

`stuck-reconciler-wiring-5396.test.js` es el importante: verifica la **política
real** de `buildStuckReconcilerDeps` (no un `allowed: true` mockeado). El objeto
`deps` se extrajo de `pulpo.js` a `lib/stuck-reconciler-deps.js` justamente para
que ese test sea posible sin cargar 16k líneas con side-effects.
