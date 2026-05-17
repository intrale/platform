# Narrativa UX — Commander Determinístico (#3257)

> Script narrativo del sistema visual diseñado para issue #3257. Cubre las
> plantillas Markdown de Telegram y el card del dashboard. Pensado para ser
> leído por edge-tts y adjuntarse al review UX como guía verbal.
>
> Voz sugerida: `es-AR-ElenaNeural` (Lili), `--pitch=+10Hz`, `--rate=+0%`.

---

## Prólogo — por qué un sistema visual para el Commander

El Telegram Commander es la ventana operativa al pipeline. Cuando todo va
bien, lo usamos para chequear estado; cuando algo falla, es lo primero que
miramos. Hoy ese ojo depende del LLM hasta para preguntar "¿qué hora es del
pulpo?", y eso tiene dos problemas: gastamos tokens al pedo, y si la cuota
Claude se cae, perdemos visibilidad justo cuando más la necesitamos.

El issue #3257 separa al Commander en dos pistas. Una pista *determinística*
que responde sola, con datos del filesystem, sin tocar al LLM. Y una pista
*LLM* para lo que sí necesita razonamiento: crear historias, analizar
rebotes, decisiones complejas.

Este sistema visual es la cara de esa separación. Cada plantilla Markdown
y cada token del dashboard comunica esa pista — sin gritarlo, pero con
intención.

---

## Capítulo 1 — Las plantillas Markdown

Hay doce plantillas en `lib/commander/templates/`. Nueve son los comandos
felices del CA-2: status, snapshot de ola, listado de issues, allowlist,
tail de logs, levantar y bajar dashboard, screenshot, procesos node,
salud del pulpo, modo descanso. Tres son los estados tristes: rate limit,
comando no entendido, args inválidos.

Cada plantilla sigue cuatro reglas de tono. Primero, español rioplatense,
voseo informal, sin tecnicismos cuando hay sinónimo natural. Segundo,
máximo veinte líneas visibles sin scroll, porque Telegram se lee en el
celular. Tercero, emoji semántico, no decorativo — cada emoji codifica
estado o categoría, nunca está de adorno. Y cuarto, mensajes de error
amables, jamás culpabilizadores. "Calma, pibe, esperá un toque" mejor
que "Demasiados pedidos rechazados".

El placeholder `{{variable}}` se rellena con escape MarkdownV2 automático.
Eso cumple con el criterio CA-12 de seguridad: cualquier input adversarial
con asteriscos, backticks o brackets se renderiza como texto literal y
no rompe el Markdown. La triple llave `{{{variable}}}` es excepción para
cuando el contenido ya es Markdown válido — por ejemplo, una plantilla
chica compuesta dentro de otra grande.

---

## Capítulo 2 — El card del dashboard

El mockup `15-commander-routing-metric.svg` muestra cómo se ve la métrica
CA-4 en el dashboard. Tres cards en fila. La de la izquierda es un donut
con el ratio de hoy: porcentaje determinístico, porcentaje LLM, porcentaje
sin clasificar. La del medio es la tendencia de los últimos siete días,
con barras stacked. La de la derecha son tres KPIs derivados: tokens
ahorrados, comandos resueltos sin LLM en la semana, y latencia mediana
de la pista determinística.

La paleta es deliberada. El gris semántico —token `--deterministic`—
representa la pista sin gasto de tokens. El violeta —token `--purple`—
representa la pista LLM, coherente con el badge de "definición" que ya
existe. El rojo del segmento "no clasificado" es una llamada a la
acción: si ese porcentaje sube, hay que revisar el router del CA-1 o
sumar entradas al allowlist del CA-7.

Hay un marker chico arriba de la barra de tendencia del martes que dice
"CUOTA". Eso comunica que ese día la cuota Claude estaba agotada y el
routing se forzó hacia determinístico. Es el mismo patrón que usamos
para el cost-anomaly del issue 2882: contar el incidente sin desordenar
el chart.

Abajo de todo hay un sticker grande, ambar, que aparece solamente
cuando el modo degradado está activo. El color es `--quota-degraded`,
que ya existe en `design-tokens.css` desde el issue 2955 — no se
inventa nada nuevo. El sticker dice "Modo degradado: cuota Claude
agotada. Los comandos LLM caen a respuesta enlatada hasta el reset.
Los determinísticos siguen normales".

Esa última frase es la promesa de UX del issue: incluso cuando todo
arde, el Commander mantiene visibilidad.

---

## Capítulo 3 — Cómo encaja con la pipeline existente

El sistema reutiliza los tokens reales del dashboard, los iconos reales
del sprite, y la convención de mockups SVG que ya está aprobada desde
los mockups 01 al 14. No introduce paleta nueva ni tipografía nueva.

Lo único nuevo es:

— un directorio `lib/commander/templates/` con 14 archivos Markdown,
— un mockup SVG numerado `15` en `assets/mockups/`,
— este audio narrado para hacer dogfooding del sistema TTS del issue 2518.

El dev que tome este issue en fase de implementación tiene tres cosas
hechas que normalmente armaría a las apuradas: el contrato textual
(las plantillas), el contrato visual (el card del dashboard), y el
contrato de tono (este audio y el README). Lo que le queda es enchufar
el helper `fillTemplate`, escribir el router del CA-1, y los tests del
CA-6 — esto no es problema de UX.

---

## Epílogo — lo que no entra acá

No entra el router de intent en sí, eso lo decide el dev. No entran los
handlers determinísticos, eso es lógica de negocio. No entra el endpoint
JSON `/metrics/commander/routing`, eso lo arma el dev cuando conecta el
card al backend. No entran los tests, esos los escribe el dev.

Lo que sí entra es: cómo se ven y cómo se sienten todos esos mensajes
y métricas cuando llegan al ojo del operador. Que es Leo, en su celular,
a las dos de la mañana, pidiéndole al pulpo que le diga si la ola está
avanzando o se trabó.

Para ese momento, está pensado este sistema.
