# Copy del aviso de respuesta perdida — #6440

Entregable de UX de la fase `definicion/criterios`. Es el **vocabulario cerrado** del aviso
que el operador recibe cuando un pedido suyo **se ejecutó** y la respuesta **nunca le llegó**.

| Archivo | Qué es |
|---|---|
| `copy.json` | Fuente única del texto visible. Ningún string del aviso se escribe en otro lado. |
| `render.js` | Implementación de referencia de `renderAviso(aviso, datos, { now })` y `buildDropfile(texto, chatId)`. Pura, sin I/O ni reloj interno. |
| `validate-copy.js` | Valida los tres avisos ya interpolados contra UX-3…UX-8 y contra la regex literal de CA-12. |

## Cómo lo consume el dev

Dos formas válidas:

1. `const COPY = require('../../assets/copy/orphan-turn/copy.json');` y portar la lógica de
   `render.js` al módulo del barrido. Es la preferida: el copy queda en un solo lugar y se
   puede editar sin tocar código.
2. Inlinear los literales, **con un test que assertee igualdad contra `copy.json`**. Sin ese
   test el copy se desincroniza en el primer retoque.

`validate-copy.js` es el espejo ejecutable del criterio de UX. Corre solo:

```bash
node .pipeline/assets/copy/orphan-turn/validate-copy.js   # exit 0 / exit 1 con el detalle
```

## Los tres avisos

| Aviso | Cuándo sale |
|---|---|
| `H1_respuesta_perdida` | El registro dice que se ejecutó y la entrega **no** está confirmada. |
| `H2_entrega_no_verificable` | Pedido anterior al registro estructurado: no se puede afirmar ni descartar la entrega. Escala a “revisá”, nunca suprime el aviso. |
| `H3_varias_respuestas_perdidas` | 2 o más pérdidas de la misma conversación en una misma pasada. Reemplaza a los N avisos individuales. |

## Anatomía (UX-3)

Cuatro bloques, orden fijo, uno por línea, sin líneas en blanco:

```
{marcador} qué pasó
qué significa para vos ahora
dónde mirar
de qué pedido hablamos
```

El segundo bloque es **obligatorio** en los avisos de pérdida. El daño del episodio del
2026-08-24 no fue el silencio: fue que el operador estuvo 70 minutos por reenviar un pedido
que ya se había ejecutado entero. Un aviso que no advierte eso resuelve la mitad del problema.

## Las dos cosas que más fácil se rompen al implementar

1. **Emitirlo con `notifyTelegram`.** No. Antepone `componente: ` y agrega una línea
   `emisor: pid=… host=… ts=…` que es jerga prohibida por CA-12, y su destino está anclado a
   un único chat (`resolvePrivateChatId`), incompatible con CA-13. Va por el mismo dropfile
   que cualquier respuesta del Commander, con `plain: true` **explícito**. Ver UX-2.
2. **Decirle “huérfano” al operador.** `huerfano` es el valor del enum y el vocabulario del
   dashboard. En el mensaje se dice **que la respuesta se perdió**. `validate-copy.js` tiene
   un chequeo dedicado a esto (UX-4.2) porque el enum está a mano y es el error natural.

## Referencias

- Criterios vinculantes: `.pipeline/assets/mockups/6440/ux-criterios-6440.md`
- Mockups: `.pipeline/assets/mockups/6440/01-telegram-aviso-huerfano.svg` · `02-dashboard-badge-huerfano.svg`
- Tokens del badge: `.pipeline/assets/design-tokens.css` → `--result-huerfano*`
