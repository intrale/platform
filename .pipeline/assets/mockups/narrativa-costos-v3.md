# Narrativa — Ventana Costos V3 (#3735, split de #3715)

> Texto narrado por Lili (perfil `ux`) que acompana el mockup
> `.pipeline/assets/mockups/32-costos-v3.svg`.
> Voz objetivo: `es-AR-ElenaNeural`, pitch `+10Hz`, tono didactico.
> Generar con `edge-tts` cuando se ejecute el pipeline visual.

## Script narrado

Hola equipo, soy Lili. Les cuento como rediseñamos la ventana Costos del
dashboard V3 para el split numero treinta y cinco del epico tres mil
setecientos quince. Es la ventana que el operador mira cuando quiere saber
cuanto plata le esta saliendo el pipeline en este momento, y por que.

Arrancamos por que existe. El monolito `dashboard.js` tiene Costos repartido
en dos lugares: el banner de anomalia mas el pill en el header viven
embebidos en el shell del dashboard, entre las lineas cinco mil veintitres y
cinco mil noventa y nueve; y los KPIs, las tablas por skill, fase e issue,
las tarjetas de proyeccion mensual, la comparativa LLM contra deterministico
y el desglose de TTS por issue viven en la pagina `barra consumo`, que es un
HTML standalone que arranca en la linea siete mil novecientos trece. En este
split extraemos el primer bloque, el banner mas el pill mas las piezas
embebidas en home, a su propio modulo, `views/dashboard/costos.js`. La
pagina `barra consumo` queda como esta; su consolidacion con el modulo nuevo
sale como recomendacion abierta, issue tres mil setecientos setenta y nueve.
Asi acotamos el scope y evitamos un PR enorme con dos superficies mezcladas.

Ahora la parte visual. El header preserva los IDs invariantes
`hashtag costos guion window` y `data guion section igual costos` porque el
cliente refresca el dashboard con DOM morphing y los necesita exactos.
Mantenemos el chevron de colapso, el titulo "Costos", y el popout a `barra
section igual costos`. Sumamos un chip en el header con el costo agregado en
vivo, cuatro coma setenta y dos dolares por hora, que le da al operador el
numero protagonico de un vistazo. Usamos la familia teal porque Costos es la
metrica protagonica de la ventana y queremos distinguirla del info azul que
reservamos para Historial.

Despues del header viene el banner persistente de anomalia. Lo dibujamos
con el mismo lenguaje visual del mockup numero seis del backlog historico,
familia `alert anomaly`, rosa rojo distinguible del danger puro. Tiene un
rail lateral de cuatro pixeles, un icono grande de pico de consumo, el
headline en blanco, la linea con actual contra esperado en el rosa fluor, y
una linea de top tres skills consumidores en gris claro con los nombres de
skill destacados. A la derecha del bloque de texto, una mini grafica de las
ultimas veinticuatro horas con la curva del consumo y el pico marcado con un
puntito brillante. Abajo, las acciones operativas: un boton "ya lo vi" para
el ack y un selector con tres opciones de snooze, una hora, cuatro horas y
veinticuatro horas. El veinticuatro horas esta resaltado en violeta porque
es el cap maximo hardcoded. Cada una de esas cuatro acciones lleva tooltip
informativo, texto estatico server side, escapado con `escape html ssr`. Los
textos los acordamos con Product Owner: "confirma que viste la alerta",
"silencia una hora", "silencia cuatro horas util cuando sabes que viene una
rafaga", y "cap maximo, no se puede mas". Esos son los tooltips numero uno
al numero cuatro del criterio de aceptacion cuatro punto uno.

El banner se exporta como `render costos banner state` para que home.js lo
pueda invocar tambien sin duplicar la request al endpoint. Esta es la
opcion A del riesgo numero tres del architect: acoplamiento ligero,
testeable, sin doble fetch. Decision cerrada con guru.

Despues del banner viene la grilla de KPIs, seis en total, distribuidos
tres por dos. El primero, costo estimado total, lleva rail teal porque es
el KPI protagonico de la ventana. Los otros cinco son: TTS costo en
violeta porque la familia TTS tiene su identidad propia, sesiones en info
azul, tokens IN slash OUT en purpura, latencia media en amber stale, y el
ratio LLM contra deterministico en verde success. Cada KPI tiene su delta
contra el periodo previo, con flecha y color: verde si bajo, rojo si subio,
porque para costos bajar es bueno. Cada uno tiene tambien un icono "i" en
la esquina superior derecha que abre el tooltip explicativo con la formula
y el target.

Despues viene la tabla de top skills por costo. Cada fila tiene un rail
lateral de tres pixeles con el color del provider del skill: naranja
anaranjado para Anthropic, verde Codex para OpenAI Codex, ambar para Groq,
azul Google para Gemini. Asi el operador identifica de un vistazo si el
gasto se concentra en LLMs pagos o en free tier. Las columnas son skill,
provider con chip de color, sesiones, costo en dolares, porcentaje del
total y promedio por sesion. Las filas son clicables y arrastran al drill
down de las ultimas sesiones del skill. Tooltip: "click para drill down de
las ultimas sesiones de este skill", tooltip numero cinco.

Abajo van dos tablas compactas lado a lado: por fase y por issue. Por fase
muestra cuatro chips con los nombres de las fases en su color de lane,
purpura para criterios, teal para dev, verde para aprobacion, info para
verificacion, con el costo y el porcentaje. No tiene drill down separado
porque la fase ya esta cubierta por la tabla de skill. Por issue es
distinta: las filas son clicables y arrastran al drill down de la timeline
cronologica del issue. Tooltip numero seis del criterio cuatro punto uno.

Las proyecciones mensuales son tres tarjetas con semaforo dual encoding,
color mas icono mas texto, porque WCAG doble A no permite codificar
informacion solo por color. La primera es la proyeccion mensual, hoy en
estado "supera quota" rojo, con el triangulo apuntando hacia arriba, el
porcentaje sobre el cap y el numero de cap mensual configurado. La segunda
es la proyeccion semanal en amber stale, "cerca de cap", con un rombo. La
tercera es la proyeccion del dia en verde success, "dentro de cap", con un
check. Cada tarjeta tiene rail lateral con el gradiente de su estado.

La comparativa LLM contra deterministico la dibujamos como una barra
horizontal de dos segmentos. El segmento azul info con el porcentaje de
LLM, el segmento gris atenuado con el porcentaje deterministico. Abajo de
la barra, dos leyendas con la cantidad de sesiones y el costo de cada
camino, mas el ahorro estimado en verde grande: "ahorro de cuarenta y
cuatro coma sesenta y dos dolares por dia, menos cincuenta y ocho por
ciento sobre LLM puro". Tooltip numero siete del criterio cuatro punto
uno.

Por ultimo, el TTS por issue. Es una tabla con boton de expand por fila.
Cuando abris la fila se muestra el drill down de los providers TTS que
participaron: edge dash tts en teal del free tier, groq dash tts en amber
porque es paid, gemini dash tts en azul Google. Cada provider con sus
segundos y su costo. Usamos `details summary` nativo para que sea
accesible por teclado sin JavaScript adicional, mismo patron que en
Historial.

Para la variante fallback inerte, ilustramos abajo del frame principal el
cartel que el dashboard debe mostrar cuando el `require` del modulo
arroja. Icono de warning ambar, titulo "ventana costos no disponible",
subtitulo explicativo, y linea monoespaciada con el log que se emite.
Mismo patron que el resto de las ventanas del epico, criterio A tres del
sistema visual.

Sobre seguridad, hay tres puntos clave. Primero, los endpoints POST de
ack y snooze migran al mismo split, a `lib slash cost dash anomaly slash
api punto js`, siguiendo el patron de multi provider api punto js.
Aplicamos defensa en profundidad sobre cada uno: header `sec dash fetch
dash site` igual `same dash origin` obligatorio, content type
`application slash json` estricto, y validacion server side de horas
dentro del whitelist uno, cuatro, veinticuatro. Si llega un valor fuera
del whitelist devolvemos cuatrocientos. Segundo, todos los `onclick`
inline del codigo actual, los cinco que detecto el architect, se
reemplazan por `add event listener` en `render costos client script`.
Esto es prerequisito para que cuando entre la CSP estricta del split
tres mil seiscientos ochenta y ocho la ventana no se rompa. Tercero,
todos los datos dinamicos, skill, fase, issue, top skills y nombres de
providers, pasan por `escape html ssr`. Mientras el helper compartido
`lib slash escape dash html punto js` del split tres mil setecientos
veintidos no este, copiamos la version inline desde home punto js con un
comentario `TODO migrar post tres mil setecientos veintidos`.

Sobre tokens y sprite, todo viene de `design tokens punto css` y de
`sprite punto svg`. No hay hex libres en el modulo. El semaforo de quota
reusa danger, warning y success existentes; no agregamos tokens nuevos.

Los criterios de aceptacion del Product Owner cubren todo lo anterior,
ocho bloques con veintidos criterios verificables empiricamente, mas las
recomendaciones para el dev que tome la historia. Los tests requeridos
cubren cinco casos minimos: render vacio, render con anomalia activa,
XSS canonico con payload de imagen onerror, snooze fuera de whitelist, y
snooze valido. Smoke curl en los dos endpoints, mas un test extra de no
regresion del banner cuando se invoca desde home punto js, segun la
opcion A del riesgo tres.

Por ultimo, lo que queda fuera de scope: la pagina `barra consumo`
standalone que vive en la linea siete mil novecientos trece, la feature
de exportar a CSV que requiere su propio threat model anti CSV
injection, la CSRF estricta, la migracion completa de `onclick` a `data
attributes`, el snapshot test cross window, y el enforcement de `axe
core` en CI. Todo eso tiene su issue independiente: tres mil
setecientos setenta y nueve, tres mil seiscientos ochenta y ocho, tres
mil setecientos cincuenta y ocho, tres mil setecientos cincuenta y
cinco, y tres mil setecientos diecisiete.

Eso es Costos. Modulo acotado, contrato claro, defensas explicitas,
banner reutilizable, y un mockup que documenta TODO el sistema visual de
la ventana, incluyendo la variante fallback. Le toca al `pipeline dev`
armarlo siguiendo la receta del architect y los CAs del PO. Cuento con
ustedes.
