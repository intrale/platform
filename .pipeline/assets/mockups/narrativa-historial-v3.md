# Narrativa — Ventana Historial V3 (#3734, split de #3715)

> Texto narrado por Lili (perfil `ux`) que acompana el mockup
> `.pipeline/assets/mockups/31-historial-v3.svg`.
> Voz objetivo: `es-AR-ElenaNeural`, pitch `+10Hz`, tono didactico.
> Generar con `edge-tts` cuando se ejecute el pipeline visual.

## Script narrado

Hola equipo, soy Lili. Les cuento como rediseñamos la ventana Historial del
dashboard V3 para el split numero treinta y cuatro del epico tres mil
setecientos quince.

Arrancamos por que existe. El monolito `dashboard.js` tiene diez mil
seiscientas noventa y una lineas, y el bloque de Historial vive entre las
lineas dos mil ochocientas noventa y cuatro y tres mil uno. En este split
lo extraemos a su propio modulo, `views/dashboard/historial.js`, siguiendo
exactamente la plantilla que ya probamos con `home.js`, `ops.js` y los
otros splits. El contrato del modulo es una funcion pura,
`renderHistorialSsr`, que recibe el array `agentHistory` ya armado por el
padre. El modulo no toca `matrixEntries` directamente; eso baja el
acoplamiento upstream con la ventana Pipeline, que es la que arma el
estado.

Ahora la parte visual. El header preserva los IDs invariantes
`#agent-history` y `data-section="historial"` porque el cliente refresca
el dashboard con DOM morphing y los necesita exactos. Mantenemos el
chevron de colapso, el titulo, y el popout a `barra section igual
historial`. Sumamos un chip count rediseñado con la familia info,
pildora azul con borde, que refuerza la identidad de la ventana como
zona de consulta y reorden.

Antes de la lista de cards, sumamos una leyenda fija con los cuatro
estados visuales: en ejecucion, aprobado, rechazado, y finalizado sin
resultado. Es un criterio nuevo, el numero ocho del Product Owner: la
leyenda visible. Cada chip de la leyenda usa dual encoding: color, mas
icono, mas texto. Asi cumplimos accesibilidad doble A: nunca el color
solo comunica el estado.

Las cards son densas, horizontales. Cada una arranca con un rail lateral
de tres pixeles del color del estado: azul info si esta en ejecucion,
verde success si aprobo, rojo danger si rechazo, gris atenuado si
finalizo sin resultado. Despues viene el avatar de la persona del
agente, con su color identitario; despues el nombre del skill; despues,
si el issue esta en el indice de orden manual, el chip de prioridad
"hash N"; despues el numero de issue con el titulo truncado a cuarenta
caracteres; despues el chip de fase con el color de la lane; despues el
chip de estado con glyph y texto; despues la duracion y el timestamp en
fuente monoespaciada; y a la derecha las acciones.

Las acciones operativas, los cuatro botones para mover el issue arriba o
abajo en la cola, solo aparecen en cards en ejecucion. Los handlers se
mantienen 1 a 1, los invocamos por nombre desde el modulo, no los
movemos al modulo. Esto es decision cerrada del architect: los
handlers viven en el `renderClientScript` del padre y el modulo solo
emite el SSR estatico que los referencia. Cuando llegue la migracion a
content security policy estricta, los `onclick` inline cambiaran a
`data-attributes` en el split tres mil setecientos cincuenta y ocho;
hasta entonces, mantenemos el patron.

El link al pdf de rechazo es defensivo. Solo se renderea si el filename
matchea la whitelist de caracteres alfanumericos, punto, guion bajo y
guion. Si no matchea, el link se omite por completo; no caemos a un
fallback inseguro. Lo mismo para el link al log: si el filename del log
no matchea la whitelist, el `href` cae al issue de GitHub, forzando una
coercion numerica del numero de issue para evitar inyeccion por
coercion debil. Esto es defensa en profundidad sobre el escape ya
aplicado al contenido textual.

Despues de los quince primeros cards mostramos un toggle "ver N mas".
Es un elemento `details` summary nativo, accesible por teclado, sin
JavaScript adicional. Coexiste con el `toggleSection` global de la
seccion, pero son toggles independientes: el global esconde la lista
entera; el nativo expande las treinta y cinco entradas adicionales del
cap duro de cincuenta. Documentamos eso con un comentario inline en el
modulo, criterio numero veinticuatro del Product Owner.

Para la variante fallback inerte, el mockup ilustra el cartel que el
dashboard debe mostrar cuando el `require` del modulo arroja. Icono de
warning, titulo "ventana historial no disponible", subtitulo
explicativo, y linea monoespaciada con el log que se emite. Nunca
quedamos con string vacio silencioso; eso seria un anti patron grave
porque el operador no sabe que se rompio.

Los criterios de aceptacion del Product Owner cubren todo lo anterior,
veinticuatro en total. Los tests requeridos cubren doce casos: render
vacio, render basico, cinco vectores de XSS sobre `titulo`, `logFile`,
`resultado`, `skill` y `fase`, dos casos de path traversal, anti
tabnabbing, orden trabajando first, y coercion del numero de issue.
Cobertura minima del ochenta y cinco por ciento.

Sobre tokens y sprite, todo viene de `design tokens punto css` y de
`sprite punto svg`. No hay hex libres en el modulo. Los glyphs de
estado, circulo, check, cruz y guion, los mantenemos en unicode por
ahora; la migracion a sprite del criterio veintidos es opcional dentro
de este split y queda como mejora si el desarrollador quiere
implementarla.

Por ultimo, lo que queda fuera de scope: filtros, busqueda, paginacion
mas alla del cap de cincuenta, CSP estricta, migracion de `onclick`,
snapshot test cross window, y enforcement de `axe core` en CI. Todo
eso tiene su issue independiente: tres mil setecientos setenta y
ocho, tres mil seiscientos ochenta y ocho, tres mil setecientos
cincuenta y ocho, tres mil setecientos cincuenta y cinco, y tres mil
setecientos diecisiete. No multiplicamos issues; reusamos los que ya
existen.

Eso es Historial. Modulo pequeño, contrato claro, defensas explicitas
y un mockup que documenta TODO el sistema visual de la ventana. Le
toca al `pipeline-dev` armarlo siguiendo la receta del architect.
Cuento con ustedes.
