# Narrativa visual — Reporte `/ghostbusters` · «Secretos filtrados» (#5220)

> Sistema visual y de comportamiento de la salida del barrido de secretos.
> Para el dev que implementa la integración en `.pipeline/ghostbusters.js`.
> Complementa los criterios CA-1..CA-10 del agente `po`
> ([comentario de criterios](https://github.com/intrale/platform/issues/5220)) —
> **no los reemplaza ni los relaja**. Mockup: `46-ghostbusters-secretos-filtrados.svg`.

## Por qué esta historia tiene UX aunque no tenga pantalla

No hay Compose, no hay flavors, no hay íconos de app. Pero sí hay un producto que
un humano consume: **el reporte**. Y el modo de falla que el PO documentó —
`✅ Sistema sano` impreso con 26 tokens vivos en disco — no es un bug de lógica:
la lógica *encontró* los secretos. Es un **defecto de comunicación**. El sistema
sabía la verdad y la salida dijo lo contrario.

Esa es exactamente la superficie que UX cubre acá. El reporte es el único punto
donde el operador decide *«¿sigo expuesto o no?»*. Si comunica mal, la historia
se puede dar por hecha sobre un sistema todavía expuesto.

## Contexto medido (HEAD `097c6c3eb`, disco real del 30/07)

```
$ ls -d ../platform.session-* | wc -l                    -> 33
$ ls -d ../platform.session-*/.claude/.claude | wc -l    -> 33   (100%)
$ grep -n "MAX_PER_SECTION" .pipeline/ghostbusters.js    -> 1082: const MAX_PER_SECTION = 10;
$ sed -n '18p' .pipeline/lib/split-long-message.js       -> const DEFAULT_LIMIT = 3500;
$ grep -rln "split-long-message" .pipeline/lib .pipeline/*.js
      .pipeline/lib/split-long-message.js
      .pipeline/lib/__tests__/split-long-message.test.js
      .pipeline/servicio-telegram.js
$ grep -n "process.exit" .pipeline/ghostbusters.js       -> (sin resultados)
$ sed -n '10118p' .pipeline/pulpo.js
      log('ghostbusters', `Corrida terminada (exit ${code}, ...)`)
```

Dos números que se cruzan mal: **33 worktrees afectados** contra un
**truncado a 10 ítems** que ya vive en el formateador. Sin una regla explícita,
la sección nueva hereda ese truncado y esconde 23 hallazgos detrás de
`…y 23 más`.

## Los siete criterios de UX

### UX-1 · La sección de secretos no se trunca por debajo de lo accionable

`section()` (`ghostbusters.js:1083-1091`) corta a `MAX_PER_SECTION = 10`. Está
bien para basura: si hay 400 sesiones viejas, ver 10 alcanza porque el sistema
las borra solas. **Un secreto no es basura.** Cada línea que el reporte oculta es
una credencial que el operador no va a rotar, y `rotación` es acción manual,
crédito por crédito.

Regla:

| Categoría | ¿Se puede resumir? |
|---|---|
| `re-materializable por historial` | **No.** Lista completa, sin excepción. |
| `no verificable` | **No.** Lista completa, sin excepción. |
| `purgable` | **Sí**, por conteo — tras `--run` queda en `0` y no pide nada al humano. |

El agrupado inteligente sí está permitido y es preferible al truncado: una línea
por **credencial distinta** (`sha256[0:8]` + `len` + `xN worktrees`) en vez de 33
líneas repitiendo el mismo hash. Eso comprime 33 hallazgos en 4 líneas **sin
perder ni una unidad de acción**. Truncar pierde; agrupar no.

### UX-2 · La severidad viaja en la primera línea, no al fondo

`fmtReport()` emite hoy hasta quince secciones. Una sección más, agregada en el
orden de enumeración (`~:1153`), queda enterrada entre *Logs oversized* y
*Branches stale*. El operador lee el encabezado y el total liberado.

Regla: si `leakedSecrets.length > 0`, la salida abre con una **línea de banner de
severidad antes del `👻 Ghostbusters`**, y la sección de secretos se imprime
**primera**, no en el orden de las demás. Los secretos son la única categoría de
`/ghostbusters` que representa riesgo en vez de desprolijidad; el orden de
lectura tiene que reflejarlo.

### UX-3 · En Telegram se parte, no se trunca

El reporte con hallazgos supera holgadamente los 4096 chars de `sendMessage`.
Ya existe `lib/split-long-message.js` (límite 3500, prefijo `(N/M)`, respeta
fences y no parte líneas al medio), hoy usado por `servicio-telegram.js`.

Regla: el reporte se entrega por un canal que aplique ese split. **Prohibido
truncar para que entre**: el corte cae al final del mensaje, que es justo donde
viven las últimas credenciales sin rotar. Mismo criterio que la memoria
«nunca cortar audios, partir en varios».

### UX-4 · Cada categoría dice quién actúa y qué hace

`purgable` / `re-materializable por historial` / `no verificable` son términos de
ingeniería exactos y **no accionables tal cual**. El operador que lee a las 3 AM
no tiene que traducirlos.

Cada bloque de categoría lleva, debajo del título, una línea imperativa de una
sola oración:

- `historial` → «Trackeado en git — borrarlo no remedia. **Acción: rotar y revocar en el proveedor.**»
- `no verificable` → «No se pudo leer/parsear — no cuenta como limpio. **Acción: revisar a mano.**»
- `purgable` → «Untracked — el barrido lo elimina. **Acción: correr con `--run`.**»

Y cada hallazgo de `historial` muestra su **estado de rotación** explícito
(`rotación PENDIENTE` / `rotada <fecha> · revocación VERIFICADA`), que es lo que
CA-7 exige auditar. Sin ese campo el reporte no puede sostener la definición de
«cero secretos» del PO.

### UX-5 · Vocabulario de glifos propio, distinto del de basura

El formateador ya tiene un vocabulario asentado: `🗑` borrado, `✂️` truncado,
`☠️` matado, `🛡️` protegido, `🔍` dry-run. Todos significan *«el sistema se
ocupó»*.

Reusar `🗑` para un secreto que sigue vivo en el historial comunica **lo
contrario de la verdad**. Vocabulario propio, ya cubierto por iconos existentes
del sprite:

| Categoría | Glifo | Icono sprite | Token de color |
|---|---|---|---|
| `historial` | `● ROTAR` | `ic-key-rotate` | `--danger` |
| `no verificable` | `● REVISAR` | `ic-shield-lock` | `--warning` |
| `purgable` | `● PURGAR` | `ic-ghost-cleanup` | `--info` |
| sin hallazgos | `✓` | `ic-ghost-clean` | `--success` |

### UX-6 · El exit code es un mensaje, y alguien lo va a leer

CA-5 pide salir con código ≠ 0. Verificado que hoy `ghostbusters.js` no tiene
ningún `process.exit`, y que el cron del Pulpo **loguea el código literal**
(`pulpo.js:10118`: `Corrida terminada (exit ${code}, ...)`). O sea: el número
termina en un log que alguien lee sin el reporte al lado.

Regla: códigos semánticos y documentados en el `--help` del comando, no un `1`
genérico.

| Código | Significado |
|---|---|
| `0` | sin hallazgos de secretos |
| `1` | error del propio comando (reservado) |
| `2` | purgables pendientes (dry-run con hallazgos untracked) |
| `3` | no-verificables presentes → fail-closed |
| `4` | credencial persistente por historial sin rotación registrada |

Con más de una condición activa, gana el número más alto.

### UX-7 · Nada se comunica sólo por color

El reporte se rendea en consola (a veces sin color), en
`logs/ghostbusters-cron.log` (texto plano) y en Telegram (Markdown, sin control
de color). El color es **refuerzo, nunca portador**.

Regla, ya vigente en el design system: cada estado lleva **glifo + palabra**. Si
el mockup se pasa a escala de grises, se sigue leyendo entero.

## Lo que este documento NO define

- Los umbrales, patrones y clasificación técnica: eso es la receta del `architect`
  en el body del issue.
- Qué credenciales rotar y en qué orden: CA-7 del PO.
- Ninguna relajación de CA-1, CA-3, CA-5 ni CA-6. Si algo de acá pareciera
  chocar con un CA del PO, **manda el CA del PO**.

## Verificación sugerida al implementar

```bash
# UX-1 — ninguna credencial oculta tras "…y N más"
node .pipeline/ghostbusters.js --secrets --json | node -e '…'   # findings == lineas listadas

# UX-2 — la severidad esta en las primeras lineas
node .pipeline/ghostbusters.js --secrets | head -3 | grep -qi "expuesto"

# UX-3 — el reporte con hallazgos entra partido, no cortado
node -e "require('.pipeline/lib/split-long-message').splitLongMessage(rep).length > 1"

# UX-6 — el codigo de salida es el semantico, no 0
node .pipeline/ghostbusters.js --secrets; echo "exit=$?"
```

---

> Narrativa del agente `ux` · pipeline `definicion`, fase `criterios` · issue #5220.
> Ningún valor de credencial fue impreso: los hallazgos del mockup son sintéticos
> y se identifican por hash truncado y longitud.
