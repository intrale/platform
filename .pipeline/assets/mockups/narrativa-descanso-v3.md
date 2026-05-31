# Narrativa Descanso V3 — Lili (perfil `ux`)

> Texto que Lili narra acompañando el mockup `34-descanso-v3.svg` del split
> [#3736](https://github.com/intrale/platform/issues/3736) — extracción +
> rediseño V3 de la ventana **Descanso** del dashboard del operador.
>
> Voz `es-AR-ElenaNeural`, pitch `+10Hz`, tono amable y técnico.
> Salida sugerida: `.pipeline/assets/mockups/narrativa-descanso-v3.mp3`
> (la genera `pipeline-dev` o el orquestador del épico, junto al video QA).

## Script narrado

Hola equipo, soy Lili. Les paso el sistema visual de la ventana modo descanso
del dashboard versión tres, sub historia tres mil setecientos treinta y seis,
que es uno de los splits del épico tres mil setecientos quince. La pieza
fuente vive en el monolito satellites punto js, líneas mil quinientos sesenta
y uno a dos mil ciento seis, función render modo descanso, y este split
hace dos cosas: extraer ese código a su propio módulo views dashboard
descanso punto js, y aplicar el contrato visual versión tres encima.

Arranquemos por el header de la ventana. El título dice modo descanso punto
calendario semanal, con badge teal versión tres a la derecha, y un subtítulo
sobrio que dice gating de skills LLM punto hot reload sin reinicio. El rail
lateral izquierdo del header usa el gradiente rest mode, que es el indigo
nocturno siete c cinco c f f que ya está vivo en el design tokens punto css
desde el PR a de la historia dos mil ochocientos ochenta y dos. No estoy
sumando tokens nuevos. No estoy sumando íconos nuevos. Todo lo que ves
viene del sprite y del design system existente.

Inmediatamente debajo del header, en la zona explicativa, dejé tres líneas
de texto corto que le dicen al operador qué hace la ventana sin que tenga
que adivinar. Primera línea: durante los periodos configurados solo corren
los skills determinísticos. Segunda línea: aclaración de cuáles son esos
skills determinísticos, que son delivery, builder, linter y tester. Tercera
línea: los issues con label priority dos puntos critical hacen bypass del
gate, escrito explícito con la palabra bypass para que no haya duda.

Después viene el bloque más importante de toda la ventana, que es el status
header con id rm status. Este bloque tiene dos estados, activo e inactivo,
y son dual encoded: nunca informo el estado solo por color, siempre hay
ícono más texto más color juntos. El mockup ilustra el caso activo: pill
indigo con la luna creciente, título activa punto ahora veintitrés cero
cero a cero siete cero cero, y un subtítulo gris que dice dos periodos hoy
punto próximo trece cero cero. A la derecha del status pill agregué un
mini panel de tres celdas con métricas operativas derivadas del slice
enriquecido tres mil doscientos cuarenta y uno: cuánto falta para que
cierre la ventana actual, cuántos periodos tiene hoy contra el máximo
veinticuatro, y un indicador visual de que los skills LLM están en cola.
El operador entiende al toque qué está pasando.

Bajamos a la fila uno del formulario. Es el checkbox activar modo descanso.
Ya está tildado en el mockup porque la configuración del ejemplo está activa.
Al lado derecho dejé visible el hint que ya existía en el monolito, si
destildas el pipeline opera sin restricciones cee a uno punto nueve, pero
ahora también lo formalicé como tooltip operativo cumpliendo criterio cee
a tres mil setecientos treinta y seis guion cee uno. El bocadillo amarillo
debajo del checkbox muestra el contrato literal: title comilla si destildas
el pipeline opera sin restricciones paréntesis cee a uno punto nueve
comilla. El dev tiene que copiar ese texto tal cual al atributo title y al
atributo aria label del input.

Sigue la fila dos del formulario, zona horaria. Es un input texto combinado
con un data list, donde el data list se hidrata client side llamando a
intl punto supported values of con argumento time zone. El mockup ilustra
el valor por defecto, América Argentina Buenos Aires en tipografía
monoespaciada. No hay nada distintivo de visualización acá, es estándar.

Llegamos al corazón visual de la ventana, que es la grilla semanal con id
rm grid. Es siete columnas, lunes a domingo, cada una con un máximo de
veinticuatro periodos por día. Para que el mockup quepa en formato kiosk
vertical sin perder claridad, dibujé arriba una primera fila de cuatro
columnas representativas, lunes martes miércoles y jueves, mostrando cuatro
variantes distintas, y abajo una segunda fila más compacta con viernes
sábado y domingo, mostrando los casos repetidos. Esa partición es solo
del mockup, en el render real las siete columnas conviven en una sola
línea responsive que en pantallas chicas, por debajo de novecientos píxels
de ancho, colapsa a una columna vertical.

Veamos las variantes que ilustré. Lunes tiene dos periodos: el primero,
veintitrés cero cero a cero siete cero cero, lleva el caption violeta que
dice cruza medianoche con el ícono luna y el sufijo más un día. El segundo,
trece cero cero a catorce treinta, es un periodo intra día corto, una
siesta. El conteo en la esquina superior derecha dice dos sobre veinticuatro
en color neutro porque está lejos del cap. Martes tiene un solo periodo
full day: cero cero cero cero a veintitrés cincuenta y nueve, con el
caption sol amarillo que dice día completo. El conteo dice uno sobre
veinticuatro en amarillo, indicando que ya hay al menos un periodo activo
en ese día. Miércoles tiene el caso de error: dos periodos donde el
segundo, veintitrés quince a cero uno cero cero, solapa con el primero,
veintidós cero cero a veintitrés treinta. El periodo conflictivo está
bordeado en rojo, con su botón de eliminar también rojo, y abajo lleva
el mensaje warning overlap con periodo uno. El conteo del día arriba dice
dos sobre veinticuatro con una cruz roja al lado, indicando estado
inválido. La validación es client side espejo del backend, vive en el
JavaScript embebido del módulo, y según el contrato cee a tres mil
setecientos treinta y seis guion a cuatro la preservamos tal cual con
el comentario inline ef e ese e ce uno, no la consolidamos a un módulo
compartido en este split. Jueves está vacío para mostrar el empty state:
el conteo dice cero sobre veinticuatro, en el centro vertical aparece el
texto en cursiva sin periodos, y abajo el botón más periodo en color
violeta destacado. Sobre el botón dejé el bocadillo amarillo del tooltip
cee a tres mil setecientos treinta y seis guion cee tres: title comilla
máximo veinticuatro periodos por día comilla.

La fila inferior, viernes sábado y domingo, repite el patrón de un
periodo cada uno, todos con caption sol o luna según corresponda. Sobre
el botón de eliminar de sábado dejé el cuarto tooltip cee a tres mil
setecientos treinta y seis guion cee cuatro: title comilla eliminar
periodo comilla. Es el más simple de los cuatro pero igualmente
formalizado.

Debajo de la grilla viene el bloque de errores rm errors. En estado feliz
está oculto. En el mockup lo dejé visible mostrando el caso del miércoles:
una caja con borde rojo atenuado que titula errores de validación de
cliente, con el sub texto explícito nota el backend revalida igual, y
abajo el ítem específico de overlap. Es defensa en profundidad: el cliente
muestra el error inmediato para evitar submits inválidos, pero el backend
de POST barra api barra rest mode vuelve a validar igual.

Sigue la fila de acciones de submit. Tres piezas: el botón guardar
configuración en violeta con el emoji disquete, un badge contador uno
error en rojo al lado, y a la derecha el mensaje de éxito en verde
guardado punto hot reload sin reinicio del pipeline. Sobre el botón
guardar dejé el segundo tooltip cee a tres mil setecientos treinta y seis
guion cee dos: title comilla hot reload sin reinicio del pipeline punto
el backend revalida la grilla comilla. Es el tooltip más educativo de los
cuatro, porque explica el contrato operativo del POST, que escribe a disco
sin matar al pipeline gracias al watcher de rest mode state.

El footer de la ventana tiene el bloque de meta con id rm bypass y rm
updated. Bypass labels viene en read only desde config punto y a ml, no
es editable por la UI, y lo represento como tres chips: priority dos
puntos critical y priority dos puntos bypass en rojo, y rest mode dos
puntos exclude en violeta. Última actualización abajo, fecha hora en
formato es a r argentina humanizado. Es información de auditoría sobria,
no es accionable.

Cerrando la ventana dejé dos bloques más. Primero, la leyenda visual con
seis ítems explicando los códigos: cuadrado violeta es periodo activo,
sol amarillo es día completo, luna violeta es cruza medianoche, cuadrado
rojo es error, número sobre veinticuatro es el conteo del día con regla
de color, y círculo neutro es skills determinísticos siguen corriendo.
Segundo, el bloque fuera de scope, que es la lista explícita de cosas
que este split no entrega: no introduce ce ese erre efe nuevo, no
consolida la duplicación cliente backend de validación, no migra al
helper lib escape html, y no introduce wizard de doble confirmación ni
preview live del countdown. Es importante dejarlo visible para que el
review no rechace por scope creep.

Última pieza del mockup: la variante fallback inerte. Sigue el patrón
ya establecido por sub historias hermanas como ops, providers y
bloqueados. Cuando el require del módulo descanso falla en boot del
dashboard, dashboard punto js loguea descanso view unavailable más
mensaje del error y renderiza un cartel visible con ícono warning
amarillo, título ventana descanso no disponible, subtítulo explicando
que el módulo views dashboard descanso punto js falló al cargar, una
línea monoespaciada que cita literalmente la línea del log para
trazabilidad, y un tip de recovery indicando que el path legacy barra
modo descanso sigue activo via guard en dashboard routes punto js. Es
crítico: el render nunca queda en blanco silencioso, eso es anti patrón
rechazado en verificación. Cierra cee a tres mil setecientos treinta y
seis guion a dos junto con cee a a tres del épico.

Tres decisiones congeladas que vale la pena destacar antes de cerrar.
Primera, el slug nuevo es descanso, sin el prefijo modo guion, y el path
legacy barra modo descanso queda vivo sin redirect. Son orígenes
operativos distintos: deep link directo al path legacy versus router
cliente con query view igual descanso. Ambos coexisten, igual que hizo
operaciones con su slug ops y path legacy barra ops. Cierra cee a tres
mil setecientos treinta y seis guion bee uno bee dos bee tres. Segunda,
inline escape html ese ese erre con cobertura o doble u a ese pe canónica
ampersand menor que mayor que comilla doble comilla simple barra. El
helper compartido lib barra escape html punto js todavía no aterriza en
main, es dep número uno del épico, así que cada split de esta ola usa el
inline copia de home punto js líneas treinta y tres a cuarenta y uno. La
migración al helper centralizado es un PR separado que cierra dos mil
novecientos uno. Tercera, el SSR de la ventana descanso no recibe state
del servidor: toda la hidratación es client side via fetch barra api
barra rest mode cada ocho segundos. El XSS guard se concentra en el
JavaScript embebido del módulo, asegurando text content y create element
en todos lados, nunca inner html con datos del servidor. Eso es cee a
tres mil setecientos treinta y seis guion de tres, verificable con un
regex sobre el string del script extraído.

Lo que viene. Pipeline dev toma este mockup, este sprite, estos tokens,
y arma el módulo views dashboard descanso punto js con la estructura
inline shell que ya consolidaron home punto js y multi provider punto
js. No usa page shell del monolito, que está en demolición controlada.
Registra el módulo en dashboard punto js con el patrón try require
catch log defensivo, y propaga descanso view al router de lib
dashboard routes punto js cubriendo tanto el path legacy barra modo
descanso como el slug nuevo query view igual descanso. Después corre
node guion guion test sobre el archivo guion guion tests barra
descanso punto test punto js con los cuatro casos del contrato: exports
canónicos, estructura SSR con los cinco selectores estructurales, x s
ese guard sobre inner html, y escape o doble u a ese pe sobre payload
canónico imagen src x on error alert uno. Smoke curl contra ciento
veintisiete cero cero uno tres mil doscientos barra modo descanso y
contra dashboard query view igual descanso, ambos deben devolver cuatro
matches de los selectores estructurales. Yo vuelvo en validación a
verificar que los assets están donde los dejé. Y vuelvo en aprobación
para evaluar el screenshot real contra este mockup, considerando el
relajamiento de video para infra del pipeline según la regla simétrica
con producto omán. Cualquier duda, estoy al pie del cañón.
