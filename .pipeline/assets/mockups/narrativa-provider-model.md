# Narrativa — Badges `provider:model` y columna `model_used` (#3086)

> Guion de presentación del sistema visual entregado por UX para U1 multi-provider.
> Voz Lili (Edge TTS, español argentino, ritmo natural). Duración estimada ~2:30.

---

## Apertura — el problema que resuelve

Hola Leito. Te presento el sistema visual que diseñé para el issue 3086, que es la
parte UI del rediseño multi-provider del pipeline.

El problema concreto: a partir de la migración a multi-provider, vamos a tener
agentes corriendo con Anthropic, agentes con OpenAI, agentes con OpenAI-Codex, y
los skills determinísticos como builder y tester. Hoy, con Anthropic única, no
hace falta diferenciar nada en el dashboard — pero cuando convivan dos o tres
proveedores en paralelo, vos necesitás saber de un vistazo qué proveedor está
ejecutando cada agente y revisar el histórico para ver decisiones de routing
o switches recientes.

## La paleta — colores con identidad y contraste

Propuse cinco tonos en `design-tokens.css`, sección `3.c PROVIDERS`:

- **Anthropic** queda en cobre cálido, tono `#E5946B`. Es la familia copper que
  Anthropic usa en su brand pero traducida al fondo oscuro del dashboard, con
  contraste 7.4 a 1 sobre el surface base. Eso entra en AAA para texto grande.

- **OpenAI** queda en esmeralda claro, `#34D399`. Es la familia verde de
  OpenAI, deliberadamente diferenciada del verde puro de éxito (`#3FB950`) y del
  teal de acento V3 (`#2DD4BF`) para que no se confundan en una pantalla con
  varios badges juntos. Contraste 8.9 a 1.

- **OpenAI-Codex** comparte el árbol identitario de OpenAI pero un tono más
  profundo, `#10B981`. La idea es que los dos sean primos visuales — porque son
  el mismo proveedor con deployments distintos — pero diferenciables sin tener
  que leer el texto. Para reforzar la distinción, el icono de Codex agrega los
  chevrons `< >` adentro del hexágono compartido con OpenAI.

- **Deterministic** reusa el gris secundario que ya teníamos para skills sin LLM.
  Acá no inventé nada: el dashboard ya distingue builder y tester como
  no-LLM, lo dejé alineado a esa convención.

- **Unknown** mapea al amber de warning. Cuando el audit trail no reporta
  proveedor, o cuando llega un valor fuera de la allowlist, el badge se dibuja
  con icono de signo de pregunta. Es el comportamiento que pide el R6 del review
  de seguridad: nunca asumir Anthropic Opus por default cuando falta el dato.
  Si hay sesiones viejas pre-S5 en el log, se ven como "n/d" hasta que rote la
  retención.

## Los iconos — refuerzo accesible

Cada proveedor tiene un glyph propio en `sprite.svg`, todos con la convención
del sistema: viewBox 24 por 24, stroke 1.75, currentColor. Esto cumple el R2 del
review de seguridad que pide nunca comunicar información sólo por color: hay
color, hay icono, y hay texto. Tres canales redundantes.

- Anthropic: un asterisco radial de seis puntas con un núcleo sólido. Es la
  reducción más simple del starburst que usa Anthropic en su mark.
- OpenAI: un hexágono exterior con un hexágono interno rotado, sugiere el
  knot/spirograph sin replicar el logo oficial.
- OpenAI-Codex: el mismo hexágono exterior — porque pertenece al mismo árbol —
  pero con los chevrons `< / >` en el centro, indicando deployment de código.
- Unknown: signo de pregunta dentro de círculo, color amber.
- Deterministic: chip integrado con cuatro pines a cada lado, metáfora directa
  de "ejecuta sin LLM".

## El layout — live y histórico

El mockup número diez muestra los dos lugares donde aparece la información:

En la vista live, el badge va arriba a la derecha de la card de cada agente
activo, en formato `provider dos puntos modelo`, todo en monospace para que se
parsee de un vistazo. Abajo de la card, en gris terciario, agregué la versión
del CLI y el SHA del adapter del provider — cumple el R7 de seguridad que dice
mostrar metadata útil pero sin filtrar payload sensible.

En el histórico, agregué la columna `MODEL_USED` entre RESULTADO y DURACIÓN.
Es ancha porque el badge incluye icono más texto. Arriba de la tabla puse seis
chips de filtro — todos, anthropic, openai, openai-codex, deterministic,
unknown — y aclaré en el subtítulo que la validación del filtro va en backend,
no se confía en frontend (R3).

Al pie del bloque dejé una leyenda explícita con los cinco proveedores y una
descripción corta de cada uno. Esto cumple el criterio de aceptación del issue
sobre tooltips o leyenda explicativa, pero lo hice como leyenda permanente
porque el dashboard se mira en kiosko y los tooltips pasivos no son la mejor
ergonomía para un panel de operación.

## Restricciones cumplidas

Todo el sistema visual reusa tokens existentes. La paleta nueva queda contenida
en una sección agregada de `design-tokens.css` — cinco proveedores, cuatro
variables por cada uno: base, dim, bg, fg. Total veinte variables nuevas, cero
valores hardcoded en la vista, cero divergencia entre front y back porque la
allowlist viene de `agent-models.json` (#3072).

Los siete requisitos de seguridad R1 a R7 están reflejados en el mockup como
anotaciones técnicas. La implementación es responsabilidad del pipeline-dev,
pero el sistema visual ya está atado a esos requisitos: el badge `unknown`
existe porque R6 lo exige, los chips de filtro mencionan la validación
server-side porque R3 la exige, y la metadata extra del CLI/adapter en el
footer respeta R7.

## Cierre

Los assets quedan commiteados en la rama del agente. El pipeline-dev que tome
la implementación tiene tres archivos para integrar: la paleta extendida de
tokens, los cinco iconos nuevos del sprite, y este mockup como referencia
visual end to end. Si en review aparece algo que mejorar, vuelvo a revisar.
Saludos, Lili.
