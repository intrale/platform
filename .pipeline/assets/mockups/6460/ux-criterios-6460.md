# Criterios de UX vinculantes — #6460 (aviso al operador)

Sub-historia de #6440, **mitad de aviso**. El copy y el renderer ya se entregaron en la
pasada de #6440; esta pasada **no rediseña el texto**: verifica que el asset siga vivo y
usable, y **cierra el hueco que impedía consumirlo sin reintroducir el bug**.

Los criterios UX-1…UX-10 de `.pipeline/assets/mockups/6440/ux-criterios-6440.md` siguen
vigentes tal cual. Acá se agrega **UX-11** y se corrige el punto de entrega.

## Entregables de esta pasada

| Archivo | Estado |
|---|---|
| `.pipeline/assets/copy/orphan-turn/copy.json` | sin cambios (mismo hash que #6440) |
| `.pipeline/assets/copy/orphan-turn/render.js` | **modificado** — `buildDropfile` soporta las dos ramas de destino (UX-11) |
| `.pipeline/assets/copy/orphan-turn/validate-copy.js` | **extendido** — audita UX-11.1…UX-11.5 |
| `.pipeline/assets/copy/orphan-turn/README.md` | **actualizado** — tercera trampa documentada |
| `.pipeline/assets/mockups/6460/ux-criterios-6460.md` | nuevo (este archivo) |

Todo publicado en la rama `agent/6460-ux-assets`, **con base `origin/main`**.

## Por qué hubo que tocar el asset

`.pipeline/assets/copy/orphan-turn/` **nunca llegó a `origin/main`**: quedó sólo en
`agent/6440-ux-assets`, mientras que el resto de la entrega de #6440 (los dos SVG, el doc de
criterios y los tokens `--result-huerfano*`) **sí** está en `main`. El body de #6460 exige
`require('../../assets/copy/orphan-turn/render')`: en un worktree limpio de `main` ese
`require` tira `MODULE_NOT_FOUND`, y `node .pipeline/assets/copy/orphan-turn/validate-copy.js`
—test obligatorio del issue— ni siquiera arranca.

Y el asset, tal como estaba, **no podía consumirse sin reintroducir el bug**: su
`buildDropfile` estampaba `chat_id` **siempre**, que es exactamente la trampa que el punto 3
del body describe. UX no puede pedir "usá el renderer de referencia" y a la vez entregar un
renderer que sólo sabe construir el dropfile que muere en silencio.

## UX-11 — El destino se declara en dos formas y nunca se infiere

**Regla.** `buildDropfile(texto, chatId)`:

| Llamada | Devuelve | Cuándo |
|---|---|---|
| `buildDropfile(t, null)` | `{ text, plain: true }` | el destino es el chat por default (el del ancla) |
| `buildDropfile(t, '-1002345678')` | `{ text, plain: true, chat_id }` | otra conversación; el ancla lo valida |
| `buildDropfile(t)` / destino inválido | **throw** | `undefined` NO es alias de `null` |

**Fundamento verificado en `origin/main`** (no es interpretación del body):

- `lib/notify-telegram.js` → `resolvePrivateChatId(requested)`:
  - `requested == null` ⇒ `{ok:true, chatId:null}` — camino por default, **el único que el
    ancla no puede rechazar**.
  - ancla vacía ⇒ `{ok:false, reason:'no_operator_chat_id'}`.
  - destino ≠ ancla ⇒ `{ok:false, reason:'unauthorized_chat_id'}`.
- `servicio-telegram.js`, rama de texto: `if (!privateDestination.ok) { log(...);
  fs.renameSync(trabajandoPath, path.join(LISTO, file.name)); continue; }` — archiva el
  dropfile como procesado **sin llamar a Telegram y sin `writeSentReceiptIfAny`**.

O sea: con el ancla vacía, un dropfile con `chat_id` no sólo no se envía — tampoco deja
recibo que el reconcile pueda cerrar a `fallido`. El operador queda igual de callado que en
el episodio del 2026-08-24, y el sidecar no tiene de dónde sacar `aviso_entregado: false`.

**Por qué `undefined` tira error en vez de caer al default.** Omitir el argumento por
descuido y que el aviso salga igual es adivinar un destino. Un aviso que dice "ya está hecho,
no lo repitas" en la conversación equivocada es una instrucción equivocada para quien lo lee
y sigue siendo silencio para quien lo esperaba. El camino por default se elige **explícito**
o no se elige.

**Qué NO cubre UX-11.** Resolver el destino (pasos 1-2 del body: `correlation_id` →
`resolveChatIdForCorrelation`, si no la etapa `transcripción` del canal estructurado) es del
dev. UX sólo fija que, una vez resuelto, el dropfile pueda expresar las dos ramas y que un
destino no resoluble **descarte y registre**, nunca encole a ciegas.

## Cobertura ejecutable

`validate-copy.js` audita UX-11 además de UX-3…UX-8:

- **UX-11.1** — `buildDropfile(t, null)` no puede traer `chat_id`; conserva `plain:true` y el texto.
- **UX-11.2** — la rama dirigida propaga el destino y conserva `plain:true`.
- **UX-11.3** — `undefined`, `''`, `'abc'`, `'0'`, `'01'`, `12345`, `{}`, `NaN` ⇒ todos tiran.
- **UX-11.4** — texto vacío ⇒ tira (nada de dropfiles mudos).
- **UX-11.5** — los tres avisos reales sobreviven intactos a las dos ramas.

Verificado que el gate **falla** ante la regresión: parcheando `render.js` para estampar
`chat_id` en la rama ancla, el validador sale con `exit 1` y `UX-11.1`. Restaurado, `exit 0`.

## Lo que el dev NO tiene que hacer

- **No reescribir el texto.** Sale de `copy.json` vía `render.js`. Si producción difiere del
  renderer, el que está mal es producción.
- **No decirle "huérfano" al operador.** Es el enum y el vocabulario del dashboard.
- **No usar `notifyTelegram`.** Ver trampa 1 del README.
- **No inferir el destino del nombre del archivo de log.** Ya es CA del issue.
