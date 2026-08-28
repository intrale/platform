# Contrato de copy v2 — alerta de margen del vigilante del Pulpo (#6146)

> Agente `ux`, fase `validacion` del pipeline de desarrollo, tras el rechazo de
> `review` en `aprobacion` (rev-1). **Reemplaza la tabla de persistencia del
> contrato v1** (comentario de `criterios` del issue #6146). Todo lo que no se
> menciona acá sigue igual: los cuatro textos de `message`/`action`, el corte
> D-1 en 30s, las claves `cuánto falta` / `desde cuándo` y la regla
> anti-`snake_case` de H-UX-1 quedan **sin cambios**.

## Por qué hay un v2: el error es del contrato, no de la implementación

El módulo `pulpo-liveness-copy.js` implementó el v1 **al pie de la letra** — el
propio comentario del archivo dice "Tabla de intervalos entregada por `ux`". Los
dos defectos que encontró `review` estaban en el texto que entregó UX:

1. **La frase de persistencia afirma un hecho que el dato no respalda.** El v1
   escribió: *"De `prevAlertTs` — el de la alerta anterior"*. Pero
   `viene igual desde hace {intervalo}` es una afirmación sobre **la condición**,
   y ese dato es sobre **el aviso**. Son cosas distintas: el aviso pudo emitirse
   hace tres días, la condición normalizarse al rato y reaparecer recién ahora.
   UX conflacionó las dos y el copy quedó pudiendo mentirle al operador.
2. **La tabla no resolvió los singulares.** El v1 escribió `hace {N} minutos` y
   `hace {N} días` como plantilla cruda, resolviendo el singular sólo para la
   hora (`hace una hora`). Con N=1 sale "hace 1 minutos" / "hace 1 días".

---

## R-1 (bloqueante) · La persistencia sólo se afirma con evidencia de persistencia

**Regla de copy:**

> La clave `desde cuándo` sólo puede emitirse si existe **evidencia observada**
> de que la condición se mantuvo durante la ventana de silencio. El momento del
> aviso anterior **no es** esa evidencia. Sin observaciones degradadas en esa
> ventana, la clave se **omite entera** — mismo criterio D-3/SEC-4 que ya aplica
> el módulo: *se omite, no se degrada*.

La evidencia ya está capturada y hoy sólo se loguea: son las repeticiones
acumuladas mientras la condición se observó degradada y el aviso estaba
silenciado (`bumpAlertRepeats`, hoy en la variable `repeats` del runner). Cero
repeticiones = ninguna observación degradada en la ventana = la frase no tiene
fundamento y no sale.

**Cómo se ve el criterio, en tabla:**

| Hubo observaciones degradadas durante el silencio | Intervalo calculable | `desde cuándo` |
|---|---|---|
| sí | sí | `viene igual desde hace {intervalo}` |
| sí | no | *se omite la clave* (D-3) |
| **no** | sí (pero es sólo la edad del aviso viejo) | **se omite la clave** ← lo que arregla el v2 |
| no | no | *se omite la clave* |

**Sugerencia al dev sobre la firma** (el "cómo" es tuyo, la regla es lo que UX
contrata): hoy el parámetro se llama `prevAlertTs`, y ese nombre es justamente lo
que indujo el error — invita a pasarle "cuándo se avisó". Renombrarlo a algo que
nombre la condición y no el aviso (`persistedSinceTs`, `condicionIgualDesde`), o
agregar un flag explícito, hace que el próximo que lea el módulo no repita el
desvío. No cambia la firma en lo que importa para CA-2: el módulo sigue **sin**
recibir umbral, origen del umbral, muestras ni configuración.

**Caso de test que UX pide** (traducción directa de la regla): sin observaciones
degradadas en la ventana + un aviso anterior viejo ⇒ la clave `desde cuándo`
**no existe** en el `context`. Hoy no hay ningún caso que lo cubra.

## R-2 (no bloqueante, misma pasada) · Tabla de persistencia con singulares

Reemplaza la tabla del v1. En un issue cuyo único entregable es texto legible,
"hace 1 días" desentona — más cuando el propio módulo ya resuelve
`hace una hora`.

| Intervalo real | Texto |
|---|---|
| < 1 min | *se omite la clave* |
| 1 ≤ x < 2 min | `hace un minuto` |
| 2–59 min | `hace {N} minutos` |
| 60–119 min | `hace una hora` |
| 2–23 h | `hace {N} horas` |
| 24–47 h | `hace un día` |
| ≥ 48 h | `hace {N} días` |

El test vigente congela el defecto
(`assert.strictEqual(copy.formatPersistence(24*3600000), 'hace 1 días')`): hay
que actualizar ese caso y agregar el del minuto.

## R-3 (no bloqueante, misma pasada) · El fail-soft no puede dejar mudo al canal

Hoy, si el módulo de copy no carga, el operador **no recibe nada** y sólo queda
un renglón en un log que nadie mira. Justo este aviso es el que anticipa que el
vigilante va a reiniciar un Pulpo sano: perderlo en silencio es el peor
resultado posible para el operador. Desde UX, el silencio no es un fallback
aceptable.

**Texto mínimo, literal, sin dependencias del módulo** (va hardcodeado en el
camino de error, se manda con la misma severidad y **sin** detalle, porque el
detalle es justamente lo que no se pudo construir):

- **message:**
  `El vigilante puede reiniciar el Pulpo aunque está trabajando bien. Si lo reinicia, lo que vas a ver es que el Commander deja de responder.`
- **action:**
  `Podemos darle más tolerancia al vigilante para que no reinicie el Pulpo por ciclos lentos. Si estás de acuerdo, avisá y el pipeline aplica el cambio.`
- **context:** vacío.

`puede reiniciar` es deliberado: es verdadero en los dos niveles de urgencia, y
el camino de error no está en condiciones de afirmar cuál de los dos es.

---

## Render real de las tres situaciones

Generado con el `buildMessage()` del propio canal
(`.pipeline/lib/notify-telegram.js`, `_internal`). Sin tildes porque salió por
consola; **el copy a implementar es el de arriba, con tildes**.

```
=== A · CON evidencia de continuidad ===
⚠️ pulpo-liveness: El vigilante esta por reiniciar el Pulpo aunque esta trabajando bien. Si lo reinicia, lo que vas a ver es que el Commander deja de responder.

cuanto falta: muy poco: quedan 6 segundos de tolerancia, puede pasar en cualquier momento
desde cuando: viene igual desde hace un dia
emisor: pid=13096 host=DESKTOP-TOTQAUE ts=2026-08-20T16:55:00Z

(diag: Podemos darle mas tolerancia al vigilante para que no reinicie el Pulpo por ciclos lentos. Si estas de acuerdo, avisa y el pipeline aplica el cambio.)

=== B · SIN evidencia (mismo margen, misma antiguedad del aviso) -> clave omitida ===
⚠️ pulpo-liveness: El vigilante esta por reiniciar el Pulpo aunque esta trabajando bien. Si lo reinicia, lo que vas a ver es que el Commander deja de responder.

cuanto falta: muy poco: quedan 6 segundos de tolerancia, puede pasar en cualquier momento
emisor: pid=13096 host=DESKTOP-TOTQAUE ts=2026-08-20T16:55:00Z

(diag: Podemos darle mas tolerancia al vigilante para que no reinicie el Pulpo por ciclos lentos. Si estas de acuerdo, avisa y el pipeline aplica el cambio.)

=== C · FALLBACK del fail-soft ===
⚠️ pulpo-liveness: El vigilante puede reiniciar el Pulpo aunque esta trabajando bien. Si lo reinicia, lo que vas a ver es que el Commander deja de responder.

emisor: pid=13096 host=DESKTOP-TOTQAUE ts=2026-08-20T16:55:00Z

(diag: Podemos darle mas tolerancia al vigilante para que no reinicie el Pulpo por ciclos lentos. Si estas de acuerdo, avisa y el pipeline aplica el cambio.)
```

B es el caso que hoy sale mal: mismo margen y misma antigüedad del aviso que A,
pero sin continuidad observada. Hoy imprime `desde cuando: viene igual desde
hace 3 dias`; con el v2 la línea no aparece.

## El copy v2 pasa su propio guardián (CA-2 / CA-8 / H-UX-1)

Corrido sobre las 6 cadenas de `message`/`action` (los 2 niveles + el fallback),
las 2 claves del detalle y los 6 textos de persistencia:

```
terminos internos filtrados : 0
claves en snake_case        : 0
control (fuga plantada)     : DETECTADA (guardian vivo)
```

Es decir: el v2 **no obliga a aflojar el guardián** para pasar. El texto nuevo
del fallback tampoco introduce vocabulario interno.

## Lo que el v2 NO toca (confirmado por `review`, no se rediseña)

- Los cuatro textos de `message`/`action` de INMINENTE y ATENCIÓN.
- El corte D-1 en 30 segundos y la distinguibilidad CA-4/CA-5.
- La contención estructural de CA-2 (el módulo no recibe datos internos).
- La severidad `warn` (CA-9 / D-4).
- `pulpo-liveness-margin.js` fuera del diff (CA-10).
- El detalle técnico en el `log()` del runner (CA-7).
