# Contrato de copy v3 — alerta de margen del vigilante del Pulpo (#6146)

> Agente `ux`, fase `criterios` del pipeline de definición (20/08), re-intake por
> rebote de routing rev-2. **Entregable literal pedido explícitamente** por la
> receta técnica rev-3 del arquitecto (§4: *"el literal final — el de la frase de
> persistencia y el de rescate del §3 — lo entrega `ux` en esta misma pasada de
> `criterios` y PREVALECE"*) y por CA-6c / CA-11 / CA-12 de `po` rev-3.
>
> **Este archivo es el contrato de texto. El dev ensambla, no redacta.** Los
> literales se copian tal cual, con tildes.

## Qué reemplaza y qué no

| Contrato | Estado |
|---|---|
| v1 (comentario de `criterios`, 19/08) — tabla de intervalos + frase de persistencia | **superado** |
| v2 (`ux-copy-rev2-6146.md`, `validacion`) — R-1 regla, R-2 tabla, R-3 rescate | **vigente en la regla; los literales quedan reemplazados por los de acá** |
| Los 4 textos de `message` / `action` de INMINENTE y ATENCIÓN | **sin cambios** — `review` los dio por correctos |
| Corte D-1 en 30 s, claves `cuánto falta` / `desde cuándo`, severidad `warn` | **sin cambios** |

Lo único que cambia respecto de lo que hoy está en la rama son **L-1** (frase de
persistencia) y **L-2** (tabla de intervalos). **L-3** (rescate) es texto nuevo.

---

## L-1 · Frase de persistencia (CA-6c) — **literal final**

```js
if (desde) context['desde cuándo'] = 'ya te avisé ' + desde + ' y sigue pasando';
```

Reemplaza a `'viene igual desde ' + desde`.

**Por qué esta redacción y no la anterior.** `viene igual desde hace 3 días` es
una afirmación sobre **la condición**: dice que estuvo degradada de forma
ininterrumpida durante 72 horas. El dato que respalda la frase no dice eso — dice
que hubo *repeticiones* durante la ventana de silencio, que es compatible con
ciclos sanos en el medio. El copy afirmaba más de lo que sabía, y eso es
exactamente lo que `review` bloqueó.

`ya te avisé hace 3 días y sigue pasando` afirma **dos hechos comprobables por
separado**, ninguno de los cuales requiere continuidad:

1. *hubo un aviso anterior, hace tanto* — es la edad del aviso previo, un dato exacto;
2. *sigue pasando* — es el presente, verificado en este mismo ciclo.

Para el operador el valor de uso es idéntico ("esto no es nuevo, ya te lo dije"),
sin el costo de mentirle. Es la misma disciplina de D-3/SEC-4 que ya aplica el
módulo: **dato ausente o dato acotado, nunca dato falso.**

**Registro elegido:** primera persona (`te avisé`) para ser coherente con el
`action` que ya está en la rama (*"Si estás de acuerdo, avisá y el pipeline
aplica el cambio"*). El canal ya le habla al operador de vos; el aviso no cambia
de voz a mitad de mensaje.

**La clave del detalle sigue siendo `desde cuándo`** — minúscula, con espacio y
con tilde, nunca `snake_case` (H-UX-1). No se renombra.

## L-2 · Tabla de intervalos (CA-11) — **literal final**

| Intervalo real | Texto |
|---|---|
| < 1 min | *se omite la clave entera* (D-3) |
| 1 ≤ x < 2 min | `hace un minuto` |
| 2–59 min | `hace {N} minutos` |
| 60–119 min | `hace una hora` |
| 2–23 h | `hace {N} horas` |
| 24–47 h | `hace un día` |
| ≥ 48 h | `hace {N} días` |

Salida verificada de la implementación de referencia:

```
     59000 -> null              (se omite)
     60000 -> "hace un minuto"
     90000 -> "hace un minuto"
    120000 -> "hace 2 minutos"
   3540000 -> "hace 59 minutos"
   3600000 -> "hace una hora"
   7200000 -> "hace 2 horas"
  82800000 -> "hace 23 horas"
  86400000 -> "hace un día"
 169200000 -> "hace un día"      (47 h)
 172800000 -> "hace 2 días"
 259200000 -> "hace 3 días"
```

El test vigente congela el defecto en la línea 194
(`formatPersistence(24*3600000) === 'hace 1 días'`). **Ese assert se actualiza.**
Que un test congele el texto roto no es motivo para conservarlo.

## L-3 · Texto de rescate del fail-soft (CA-12 / SEC-6) — **literal final, constante**

Va **hardcodeado inline en el runner** (si el módulo de copy no se pudo requerir,
un literal exportado desde ese módulo tampoco estaría disponible). **Texto
constante: prohibido interpolar `err.message`, el stack o cualquier ruta.**

- **`message`:**
  ```
  El vigilante puede reiniciar el Pulpo aunque está trabajando bien. Si lo reinicia, lo que vas a ver es que el Commander deja de responder.
  ```
- **`action`:**
  ```
  Podemos darle más tolerancia al vigilante para que no reinicie el Pulpo por ciclos lentos. Si estás de acuerdo, avisá y el pipeline aplica el cambio.
  ```
- **`context`:** `{}` — vacío. El detalle es justamente lo que no se pudo construir.

**`puede reiniciar` es deliberado:** es verdadero en los dos niveles de urgencia,
y el camino de error no está en condiciones de saber en cuál de los dos está. La
alternativa —callarse— no es un fallback aceptable desde UX: éste es el aviso que
anticipa que el vigilante va a reiniciar un Pulpo sano.

**Sin backticks ni marcas de formato** en ninguno de los dos literales: el modo de
falla `400 can't parse entities` del canal (#5400) los rompe.

---

## Render real de los cuatro casos

Generado con el `buildMessage()` del propio canal
(`.pipeline/lib/notify-telegram.js`, `_internal`), sobre el módulo real de la rama
`agent/6146-pipeline-dev`:

```
=== A · INMINENTE con evidencia (frase rev-3) ===
⚠️ pulpo-liveness: El vigilante está por reiniciar el Pulpo aunque está trabajando bien. Si lo reinicia, lo que vas a ver es que el Commander deja de responder.

cuánto falta: muy poco: quedan 6 segundos de tolerancia, puede pasar en cualquier momento
desde cuándo: ya te avisé hace un día y sigue pasando
emisor: pid=20212 host=DESKTOP-TOTQAUE ts=2026-08-20T17:40:00Z

(diag: Podemos darle más tolerancia al vigilante para que no reinicie el Pulpo por ciclos lentos. Si estás de acuerdo, avisá y el pipeline aplica el cambio.)

=== B · INMINENTE sin evidencia (CA-6a: clave omitida) ===
⚠️ pulpo-liveness: El vigilante está por reiniciar el Pulpo aunque está trabajando bien. Si lo reinicia, lo que vas a ver es que el Commander deja de responder.

cuánto falta: muy poco: quedan 6 segundos de tolerancia, puede pasar en cualquier momento
emisor: pid=20212 host=DESKTOP-TOTQAUE ts=2026-08-20T17:40:00Z

(diag: Podemos darle más tolerancia al vigilante para que no reinicie el Pulpo por ciclos lentos. Si estás de acuerdo, avisá y el pipeline aplica el cambio.)

=== C · ATENCIÓN con evidencia (frase rev-3) ===
⚠️ pulpo-liveness: El vigilante se está acercando al punto en el que reiniciaría el Pulpo aunque esté trabajando bien. Si llega, lo que vas a ver es que el Commander deja de responder.

cuánto falta: todavía hay aire: quedan 80 segundos de tolerancia, pero se viene achicando
desde cuándo: ya te avisé hace 3 días y sigue pasando
emisor: pid=20212 host=DESKTOP-TOTQAUE ts=2026-08-20T17:40:00Z

(diag: Conviene resolverlo antes de que llegue al límite: podemos darle más tolerancia al vigilante. Si estás de acuerdo, avisá y el pipeline aplica el cambio.)

=== D · RESCATE fail-soft (CA-12/SEC-6) ===
⚠️ pulpo-liveness: El vigilante puede reiniciar el Pulpo aunque está trabajando bien. Si lo reinicia, lo que vas a ver es que el Commander deja de responder.

emisor: pid=20212 host=DESKTOP-TOTQAUE ts=2026-08-20T17:40:00Z

(diag: Podemos darle más tolerancia al vigilante para que no reinicie el Pulpo por ciclos lentos. Si estás de acuerdo, avisá y el pipeline aplica el cambio.)
```

**A vs. B es el caso testigo de CA-6a**: mismo margen, misma antigüedad del aviso
anterior. Lo único que los distingue es si hubo observaciones degradadas dentro de
la ventana que acaba de cerrar. Hoy los dos imprimen la línea; con el v3, B no la
imprime.

## El copy v3 pasa su propio guardián (CA-2 / CA-8 / H-UX-1 / #5400)

Corrido sobre las 4 variantes de la frase de persistencia, los 2 literales de
rescate y las 2 claves del detalle:

```
términos internos filtrados : 0
claves en snake_case        : 0
marcas de formato (#5400)   : 0
claves en lenguaje llano    : OK
control (fuga plantada)     : DETECTADA (guardián vivo)
```

El v3 **no obliga a aflojar el guardián** para pasar. La denylist usada incluye,
además de la de CA-2, la frase vieja `viene igual desde`, que a partir de esta
revisión es texto prohibido: si reaparece, es que alguien revirtió L-1.

## Lo que este contrato NO toca

- Los cuatro textos de `message` / `action` de INMINENTE y ATENCIÓN.
- El corte D-1 en 30 segundos y la distinguibilidad CA-4 / CA-5.
- La contención estructural de CA-2: el módulo sigue **sin** recibir umbral,
  origen del umbral, muestras ni configuración. La firma no se amplía (SEC-7).
- La severidad `warn` (CA-9 / D-4) y el `log()` de CA-7.
- `pulpo-liveness-margin.js`, fuera del diff (CA-10 / CA-13).
- El prefijo `pulpo-liveness:` y la línea `emisor: pid/host` — son de todos los
  emisores del canal, no de este aviso. Corresponden a #5922 (H-UX-2).
