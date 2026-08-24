# UX — Copy y observabilidad para el operador (issue #6423)

> Fase `criterios`, pipeline `definicion`. Entregable del rol `ux`.
> **Alcance visual:** `area:pipeline`, sin ningún `app:*`. No hay pantalla, ícono, splash
> ni componente Compose involucrado ⇒ **no corresponde producir assets gráficos**.
> La superficie de experiencia de este issue es **el texto que lee el operador**
> (motivos, labels de escalado, logs, Telegram, pregunta de `needs-human`).
> Todo lo de acá es **copy listo para pegar**: el dev ubica, no redacta.

---

## Por qué UX tiene algo que decir en un issue de pipeline

El bug de #6423 **es** un bug de experiencia: el sistema le pide ayuda a una persona
cuando no hay nada que decidir. La corrección técnica (clasificar `checks-pending`)
resuelve la mitad; la otra mitad es que los textos que quedan **digan la verdad de lo
que pasó**. Hoy no la dicen:

- `GATE_BLOCK_LABELS['branch-protection']` dice *"faltan reviews **o** checks obligatorios"* —
  una disyunción que obliga al operador a investigar cuál de las dos es. Post-fix el
  código **ya sabe** cuál es, así que seguir diciendo "o" es esconder información que
  el sistema tiene.
- `inferHumanBlockQuestion` le va a preguntar al operador por **CODEOWNERS** en un caso
  que no tiene nada que ver con CODEOWNERS (verificado en V4).

---

## Verificación empírica hecha en esta pasada

Ejecutado sobre HEAD `b68e65256`, no citado de memoria.

### V1 — Copy propuesto para el camino transitorio: NO matchea `HUMAN_BLOCK_PATTERNS`

```
$ node -e "const {isHumanBlockReason}=require('./.pipeline/lib/human-block.js'); ..."
--- TRANSITORIO (debe ser FALSE) ---
false | Checks requeridos todavia sin reportar en PR #6416: GitHub respondio 405 con estado BLOCKE...
false | (variante waits=1)
false | (variante 2 contextos pendientes, PR #6421)
APROBADA (con tildes) -> false
```

### V2 — Copy propuesto para gate-block: SÍ sigue matcheando (el control real debe escalar)

```
--- GATE-BLOCK (debe ser TRUE) ---
true | branch-protection-checks-red
true | branch-protection-review
true | branch-protection-other
true | branch-protection-unreadable
```

### V3 — Cinco redacciones "naturales" que ROMPEN el fix (trampas verificadas)

```
true   <- TRAMPA: nombra el ruleset      ("El ruleset de main exige un check que todavía no reportó…")
true   <- TRAMPA: dice merge bloqueado   ("Merge bloqueado temporalmente en PR #6416 por un check…")
true   <- TRAMPA: PR N pendiente…merge   ("PR #6416 pendiente de que el check requerido reporte… para completar el merge")
true   <- TRAMPA: review manual          ("Se espera la review manual requerida por el check.")
true   <- TRAMPA: requiere intervención  ("El check aún no reportó y requiere intervención humana.")
```

Las cinco son formas **espontáneas** de escribir el mismo hecho. Cualquiera de ellas
reintroduce el `needs-human` que el issue viene a eliminar. Por eso el copy va cerrado
acá y no se improvisa en dev.

### V4 — Defecto de UX NO cubierto por guru / security / arquitecto / PO

```
$ node -e "const {inferHumanBlockQuestion}=require('./.pipeline/lib/human-block.js'); \
  console.log(inferHumanBlockQuestion('Checks requeridos todavía sin reportar en PR #6416: …',{skill:'delivery'}))"

[delivery] ¿Podés mergear el PR mencionado o quitar el bloqueo de CODEOWNERS para que
el pipeline siga? Detalle: Checks requeridos todavía sin reportar en PR #6416: …
```

`human-block.js:566-568` enruta por `\bPR\s+#?\d+` y devuelve la pregunta de **CODEOWNERS**.
Post-fix, cuando el circuit breaker escale un `merge_checks_race` (único camino a
`needs-human` que queda, por D6 del arquitecto), el operador va a recibir por Telegram
y por audio una pregunta sobre un control que **no** es el que bloquea. Es el mismo
defecto de fondo que el issue arregla, una capa más arriba.

---

## Copy cerrado (pegar tal cual)

### C1 — `buildTransientMergeMotivo`, causa `checks-pending`

```js
// ⚠️ Redactado y VERIFICADO contra isHumanBlockReason (#6423 CA-UX-1). Antes de
// tocar una coma, correr el test: 5 redacciones alternativas naturales matchean
// HUMAN_BLOCK_PATTERNS y reintroducen el needs-human. Prohibido: "merge
// bloqueado", "requiere intervención humana", "review manual", "ruleset de main
// … exige/bloquea/impide", "PR #N pendiente … merge".
`Checks requeridos todavía sin reportar en ${pr}: GitHub respondió 405 con estado `
+ `BLOCKED porque el control automático [${pendientes.join(', ')}] seguía corriendo `
+ `tras ${esperas} esperas escalonadas (~104 s). No hay defecto de dev ni evidencia `
+ `de integración sucia: la entrega se reintenta tal cual, sin cambios de código.`
```

Regla de la variante: mantener el cierre *"No hay defecto de dev… sin cambios de código"*
**idéntico** al de la causa `mergeability-unknown`. Es la frase que le dice al dev que no
busque un bug suyo, y las dos causas transitorias tienen que sonar a la misma familia.

### C2 — `GATE_BLOCK_LABELS`: desdoblar `branch-protection` nombrando el control observado

```js
'branch-protection-checks-red':   'un check requerido terminó en rojo y la protección de rama frena el merge',
'branch-protection-review':       'falta la review requerida por la protección de rama',
'branch-protection-other':        'los checks requeridos están en verde pero la protección de rama sigue frenando el merge (hilo de review sin resolver, revisión de Copilot o commit sin atribuir)',
'branch-protection-unreadable':   'no se pudo leer la lista de checks requeridos de la protección de rama',
'branch-protection':              'la protección de rama bloquea el merge (control no identificado)',  // fallback
```

- El key genérico **se conserva** como fallback: `GATE_BLOCK_LABELS[gate] || …` no puede
  quedar sin destino si aparece un veredicto nuevo.
- Cada texto nombra **una** causa. Se elimina el "o" disyuntivo: post-fix el código sabe cuál es.
- `branch-protection-other` es el caso "todos verdes + BLOCKED" (regla 6 del arquitecto,
  SEC-4). Es el que más desorienta al operador — por eso enumera los tres controles
  candidatos del ruleset en vez de decir "otro control".

### C3 — Pregunta al operador para `merge_checks_race` (`inferHumanBlockQuestion`)

Agregar una rama **antes** de la de `PR #N` (que hoy captura y contesta CODEOWNERS):

```js
if (opts.preconditionType === 'merge_checks_race' || /\bchecks?\s+requeridos?\b/i.test(m)) {
    return `${skill}El PR quedó esperando que un check obligatorio de GitHub reportara y se `
         + `agotó la espera automática. ¿Podés mirar si el check ya está en verde y, si lo está, `
         + `destrabar el issue para que el pipeline reintente el merge solo? Detalle: ${m}`;
}
```

Criterio UX: la pregunta describe **el estado observado** y pide **la acción mínima**
(mirar y destrabar), no una acción que el operador no debería tener que hacer (mergear a
mano — que es justamente lo que pasó el 2026-08-24 y lo que el issue quiere dejar de necesitar).

### C4 — Logs del camino nuevo (mismo formato que #6012, sin JSON crudo — SEC-8)

```
[delivery] gate merge: requeridos pendientes [pr-status] — espera 2000ms (1/7) y reevaluación completa de gates
[delivery] gate merge: requeridos siguen pendientes tras 7 esperas — resultado TRANSITORIO (no escala)
[delivery] gate merge: requeridos leídos del ruleset — pr-status (app 15368): QUEUED
[delivery] gate merge: snapshot degradado a nivel 2 (sin statusCheckRollup) — clasificación de checks deshabilitada, #6012 sigue activo
```

- Prefijo `[delivery] gate merge:` idéntico al existente (el operador ya filtra por eso).
- Se loguea **contexto + app id + estado**, nunca el JSON del ruleset.
- El log del snapshot degradado es UX de diagnóstico: sin él, un `gh` viejo apaga el fix
  en silencio y nadie se entera (R8).

### C5 — Comentario de auto-destrabe del barrido (calcado del de #4748)

```markdown
## 🔓 Auto-destrabado por el pipeline

Este issue quedó en `needs-human` porque, al momento del merge, un check obligatorio
de GitHub todavía no había reportado. El check ya reportó y el PR volvió a estar
mergeable, así que el motivo del freeze dejó de ser cierto.

El pipeline volvió a pasar el PR por los gates completos (QA, CODEOWNERS, procedencia
y SHA pinneado) y confirmó el merge. Se retiró `needs-human` automáticamente.

_Destrabado por el barrido de carrera de checks (#6423), sobre el brazo de desbloqueo
(#4748). El fail-closed sigue vigente para los bloqueos de juicio humano._
```

Telegram (misma línea que `reapStaleHumanBlocks`):
```
🔓 Issue #<N> auto-destrabado — el check obligatorio ya reportó y el PR se mergeó pasando todos los gates.
```

### C6 — Silencio deliberado en el camino transitorio

El camino `transient` **no** encola Telegram, **no** genera audio y **no** crea marker.
Criterio UX (alineado con `feedback_idle-notification-criteria`): **no se notifica al
operador un evento sobre el que no puede hacer nada y que se resuelve solo en ~104 s.**
Notificar cada espera convertiría la corrección en ruido, que es la otra forma de romper
la atención del operador.

---

## Criterios de aceptación UX (verificables)

- **CA-UX-1** — El motivo del camino `checks-pending` da `isHumanBlockReason === false`,
  y el de `gate-block` (en las 4 variantes de C2) da `true`. Test con las **5 trampas de
  V3** incluidas como casos negativos explícitos. *(extiende T8)*
- **CA-UX-2** — `GATE_BLOCK_LABELS` nombra **un** control por variante; ninguna etiqueta
  del camino `branch-protection-*` conserva la disyunción *"reviews **o** checks"*.
  El key genérico sobrevive como fallback y hay test de que `GATE_BLOCK_LABELS[gate]`
  nunca devuelve `undefined` para los `gate` que el código puede emitir.
- **CA-UX-3** — La pregunta de `needs-human` para un marker `merge_checks_race` **no
  menciona CODEOWNERS** y pide "mirar el check + destrabar", no "mergear a mano".
  Test directo sobre `inferHumanBlockQuestion`. *(gap no cubierto por T1-T19)*
- **CA-UX-4** — El camino `transient` no encola **ningún** mensaje de Telegram ni audio
  (cero llamadas a `sendTelegram` / `sendNeedHumanAudio` en la suite). *(refuerza T9c)*
- **CA-UX-5** — Cuando el snapshot degrada de nivel, queda un log explícito que lo dice
  (C4, línea 4). Sin ese log, la desactivación silenciosa del fix es invisible. *(refuerza T15/R8)*
- **CA-UX-6** — El comentario de auto-destrabe (C5) explica la causa **en términos del
  operador** (un check tardó en reportar), no con vocabulario de la API (`mergeStateStatus`,
  `405`, `rollup`). Los detalles técnicos van al log, no al comentario del issue.
  *(memoria `feedback_rejection-reports-detail`)*

---

## No-alcance UX

- Sin assets gráficos: no hay superficie visual de producto (`area:pipeline` sin `app:*`).
- No se toca el texto del camino `409` (#5420) ni el de `mergeability-unknown` (#6012),
  salvo la parametrización por causa que la receta ya pide.
- No se cierra #6425 desde acá: C2 reduce el gap pero el issue queda vivo.
