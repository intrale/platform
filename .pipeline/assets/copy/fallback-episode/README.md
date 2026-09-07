# Copy del aviso por episodio de motor de respaldo — #6179

Entregable de UX de la fase `definicion/criterios`. Es el **vocabulario cerrado** del aviso
que el operador recibe por Telegram cuando el pipeline despacha con un motor que no es el
principal.

| Archivo | Qué es |
|---|---|
| `copy.json` | Fuente única del texto visible. Ningún string del aviso se escribe en otro lado. |
| `render.js` | Implementación de referencia de `formatEpisodeNotice(episode, { now })`. Pura, sin I/O. |
| `validate-copy.js` | Recorre las 51 variantes (evento × escalón × causa + hostiles) y valida CA-4/5/7/8/9. |

## Cómo lo consume el dev

`formatEpisodeNotice` se porta a `.pipeline/lib/commander/multi-provider.js` (~`:2054`) y se
exporta desde ahí, que es donde el issue lo pide. Dos formas válidas:

1. `const COPY = require('../../assets/copy/fallback-episode/copy.json');` y portar la lógica
   de `render.js`. Es la preferida: el copy queda en un solo lugar y se puede editar sin tocar
   código.
2. Inlinear los literales en `multi-provider.js`, **con un test que assertee igualdad contra
   `copy.json`**. Sin ese test, el copy se desincroniza en el primer retoque y volvemos al
   problema que la historia viene a resolver.

`validate-copy.js` es el espejo ejecutable del helper
`.pipeline/lib/__tests__/helpers/forbidden-copy-patterns.js` que crea este issue. Si divergen,
manda el helper del repo: acá vive el criterio de UX, allá vive el control permanente de la suite.

## Anatomía del aviso (CA-4)

Cinco bloques, orden fijo, uno por línea. El operador aprende la forma y después lee sólo lo
que cambió:

```
{marcador} qué cambió
Motivo: por qué
Desde las HH:MM (hace X).
Qué consecuencia práctica tiene
Cierre: qué va a pasar solo, o qué acción existe
```

La vuelta a la normalidad usa una plantilla más corta (3 líneas): no lleva motivo ni
consecuencia porque no hay ninguna que comunicar.

## Marcadores

| Marcador | Cuándo | Por qué |
|---|---|---|
| `⚠️` | Degradación normal: entra en respaldo o baja de escalón, con causa conocida y con herramientas. | Convención ya vigente en el canal (26 usos en `lib/`). |
| `🚨` | Requiere mirada humana: `auth`, causa desconocida, o escalón sin herramientas. | Es el único caso en que el operador tiene algo que decidir. |
| `⏳` | Heartbeat de degradación sostenida. | Se lee distinto de un cambio de estado: no pasó nada nuevo, sigue pasando lo mismo. |
| `✅` | Vuelta al motor principal. | Cierra el episodio. Sin este mensaje el operador no sabe cuándo dejar de preocuparse. |

No se usa `⛔`: en este canal ya significa "operación no permitida" y confundiría un estado
degradado con un bloqueo de permisos.

## Decisiones de UX vinculantes

1. **El aviso nombra el escalón, nunca el proveedor.** Ratifica la Decisión 1 del PO. Los tres
   escalones se describen por lo que el operador puede o no puede hacer con ellos, no por quién
   los presta. Queda prohibido agregar proveedores gratuitos a `_PAID_PROVIDER_LABELS` para
   "poder nombrar el motor".

2. **La consecuencia se redacta en tareas, no en capacidades técnicas.** "No editan archivos ni
   corren tests o builds" en vez de "sin soporte de herramientas". El operador decide si el
   trabajo de hoy sobrevive a eso; `supports_tool_use` no le dice nada.

3. **"Modo conversacional" se reusa tal cual.** Ya es el término del canal para el escalón sin
   herramientas (`multi-provider.js:886`). Inventar un sinónimo obliga al operador a aprender
   dos nombres para lo mismo.

4. **El cierre sólo pide acción cuando existe una (CA-7).** Con causa `reposo`, `cuota` o
   `transitoria` el cierre dice explícitamente "No hace falta que hagas nada": el silencio
   sobre la acción se lee como acción pendiente. Sólo `auth` y causa desconocida piden mirar.

5. **El aviso de `auth` explica su propia repetición.** CA-12 obliga a notificar en cada
   despacho mientras la causa sea `auth`, aunque el estado no cambie. Sin decirlo, el operador
   ve volver la ráfaga y concluye que la historia no funcionó. Por eso el cierre agrega
   "Mientras siga así te aviso en cada despacho; no es un error del avisador". **Ver el punto
   abierto de más abajo.**

6. **El heartbeat explica por qué existe.** "Para que el silencio no se confunda con
   normalidad" es la única línea del sistema que le enseña al operador a interpretar el
   silencio. Se mantiene textual.

7. **Un lapso redondo se dice `6 h`, no `6 h 0 min`.** Detalle chico, efecto grande: el aviso
   tiene que sonar a alguien avisando, no a un reloj volcando campos.

8. **El copy está diseñado para `parse_mode` nulo.** Sin `*`, `_`, `` ` `` ni `[]`. El
   validador falla si aparecen. Esto hace que el aviso siga siendo legible aunque alguien
   reactive Markdown, y quita el incentivo de "escapar" texto de origen externo.

9. **Enum desconocido cae al escalón más degradado, no al más benigno.** En `render.js`, un
   `tier` fuera del enum se renderiza como `gratuito_sin_herramientas`. Describir de menos una
   degradación es peor que describirla de más: el operador que confía y descubre que el
   pipeline no podía ejecutar nada deja de leer el canal para siempre.

10. **Ningún dato del episodio se interpola crudo.** Del episodio sólo salen dos números
    formateados por el propio renderer (hora y lapso). Todo lo demás es lookup contra
    `copy.json` con `hasOwnProperty` (D8). Por eso los episodios hostiles del validador
    (`constructor`, `__proto__`, `sk-…`, `claude-…`) salen limpios sin ninguna sanitización:
    no hay ruta por la que puedan entrar.

## Punto abierto que UX deja señalado (no bloqueante)

CA-12 pide que `auth` y causa desconocida notifiquen **siempre**, aunque el estado no cambie.
Es correcto como principio fail-closed, pero en el volumen real del canal (106 despachos/día
de baseline) un episodio de credenciales de 4 horas vuelve a producir una ráfaga destacada —
justo la fatiga de alerta que esta historia viene a matar, ahora con marcador `🚨`, que es peor
porque desensibiliza el marcador más fuerte que tenemos.

La salida que **no** rompe fail-closed: mantener "nunca se silencia por estado sin cambios" y
agregar sólo un piso de repetición (p. ej. 1 cada 15 min) que, si no se puede evaluar por
estado corrupto o lock no adquirido, **notifica igual**. El copy ya está preparado para
cualquiera de las dos variantes. Queda registrado como recomendación independiente; **no
bloquea este issue**.

---
Producido por el agente `ux` · pipeline de definición · fase `criterios` · issue #6179
