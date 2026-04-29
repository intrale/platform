# Narrativa del sistema visual — Lili (perfil `ux`)

> Este es el texto que Lili narra acompanando los mockups del sistema visual
> del Pipeline V3 (issue #2523 CA-14). El audio se genera con `edge-tts`
> usando la voz `es-AR-ElenaNeural`, pitch `+10Hz`, tono amable.
>
> Salida: `.pipeline/assets/mockups/narrativa-lili.mp3`

## Script narrado

Hola equipo, soy Lili, del perfil de experiencia de usuario del pipeline.
Les cuento el sistema visual que acabo de entregar para el dashboard V3 de
Intrale.

Arranquemos por la paleta. Extraje los dos colores del logo maestro —el cian
y el azul Intrale— y los convertí en nuestros acentos primarios. El fondo
sigue siendo oscuro, porque el dashboard es una herramienta de uso continuo
y queremos reducir la fatiga visual. Sobre ese fondo, todo texto principal
cumple contraste WCAG doble A o triple A; verifiqué cada par color sobre
fondo con el chequeador de WebAIM y dejé la tabla completa en el documento
del design system.

Cada lane tiene su color propio: definición es morado, desarrollo y build
son azul info, QA es teal, entrega es verde. Esto refuerza la identidad
del flujo sin que el usuario tenga que leer el encabezado para saber dónde
está parado.

Después hice la iconografía. Son veintidós íconos en un sprite vectorial
único, todos con el mismo estilo outline, trazo de uno coma setenta y
cinco, viewBox veinticuatro por veinticuatro. El dashboard lo incluye una
sola vez y referencia cada ícono con `use href`. Cada ícono usa
`currentColor`, así el contexto CSS manda el color sin duplicar SVG por
cada variante.

Cubrimos las tres fases de definición, las siete fases de desarrollo, y
ocho estados transversales: rebote normal, cross-phase, pausa parcial,
circuit breaker, needs-human, voz narrando, retrying y stale. Rebote
normal y cross-phase tienen íconos distintos, no solamente color distinto,
para que sean diferenciables incluso si el usuario es daltonico.

Los tres mockups muestran cómo se arma todo: el home del dashboard con
los tres lanes poblados y el header con identidad de marca; el drilldown
de issue individual con timeline vertical, tokens consumidos, y un panel
de voz narrando en vivo; y la página consumo coordinada con el issue
dos mil quinientos veinte, con gráfico de barras por fase y el top cinco
de issues por costo.

Además entregué la documentación viva en `docs/pipeline/design-system.md`.
Ahí está todo: paleta, tipografía, componentes con estados, accesibilidad,
cómo extender el sistema sin romper consistencia, y el mapeo de emojis
para los mensajes de Telegram, que no soportan SVG inline.

Tres decisiones que vale la pena destacar: primero, tipografía del sistema
nativa, cero CDN externo, cero fuga de IP; el dashboard funciona sin
internet. Segundo, todo SVG está saneado: sin scripts, sin handlers, sin
hrefs externos, cumpliendo los seis requisitos de seguridad que pidió el
agente security. Y tercero, un helper de escape único, para que cuando el
pipeline dev aplique esto al dashboard, no queden residuos de los cinco
escapadores distintos que hay hoy.

Lo que viene: el skill pipeline-dev toma estos tokens y este sprite, los
aplica al `dashboard.js`, y entrega el rediseño implementado. Yo
vuelvo en fase validación a verificar que los assets estén donde los
dejé, con los hashes correctos, y a revisar el video final en fase
aprobación. Cualquier duda, estoy atenta.
