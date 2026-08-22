# Narrativa Modo descanso — Lili (perfil `ux`)

> Texto que Lili narra acompañando los mockups 04, 05 y 06 del issue
> [#2882](https://github.com/intrale/platform/issues/2882) — ventana
> "modo descanso" + alerta de consumo anómalo. El audio se genera con
> `edge-tts`, voz `es-AR-ElenaNeural`, pitch `+10Hz`, tono amable.
>
> Salida sugerida: `.pipeline/assets/mockups/narrativa-modo-descanso.mp3`
> (lo genera `pipeline-dev` en la fase `dev` del PR-A, junto al video QA).

## Script narrado

Hola equipo, soy Lili. Les paso el sistema visual del modo descanso del
pipeline, la historia dos mil ochocientos ochenta y dos. Esta historia
tiene tres mockups, porque la PO recomendó partirla en tres entregas
independientes: gating horario, detector de anomalías, y canal de alerta.
Yo entregué el sistema visual de los tres en un único set, así pipeline-dev
arma cada PR sin volver a esperarme.

Arranquemos por los tokens. Sumé dos colores nuevos al sistema. El primero
es el indigo nocturno, siete-c-cinco-c-f-f, que comunica modo descanso
activo. Es violáceo pero más oscuro que el morado de definición, y está
asociado mentalmente con la noche y el sueño. El segundo es un rosa-rojo,
f-f-seis-b-ocho-a, distinguible del rojo danger puro, reservado solamente
para alertas de consumo anómalo. La idea es que cuando el operador ve ese
tono específico sepa que está mirando un alerta económica, no un fallo de
ejecución. Los dos colores están saturados en la versión base y atenuados
en la variante background, manteniendo contraste WCAG doble A en todos los
pares texto sobre fondo.

Después agregué cuatro íconos nuevos al sprite. La luna creciente con tres
estrellas, ic guion rest mode, va en la pill del header y en el banner.
La línea con pico abrupto sobre baseline punteada, ic guion cost anomaly,
es el ícono del banner persistente y el resumen del problema en una
imagen. La campana con la zeta, ic guion snooze, es para silenciar la
alerta. Y el engranaje, ic guion deterministic, marca cada tarjeta del
board cuya ejecución no depende de un LLM, así el operador entiende a la
primera por qué siguen corriendo durante la ventana.

Vamos al mockup cuatro, modo descanso activo. Es la home del dashboard a
las dos y catorce de la madrugada, dentro de la ventana once de la noche
a siete de la mañana. El header tiene tres cosas distintas a la home
normal: una pill indigo bien visible que dice modo descanso veintitrés
cero cero a cero siete cero cero, un banner secundario abajo del header
que explica con texto qué significa estar en modo descanso, y un
countdown que muestra cuánto falta para que la ventana cierre. Las
tarjetas del board respetan dos estilos: las determinísticas, builder,
tester, delivery, conservan su color verde de corriendo y muestran cero
tokens consumidos, mientras que las de skill LLM están atenuadas, con un
chip violeta que dice esperando cuatro horas cuarenta y cinco minutos.
También dejé visible un caso especial: una tarjeta con borde rojo y label
priority colon critical que sí se está ejecutando, demostrando que el
bypass funciona y que el operador puede confiar en que un crítico nunca
queda dormido.

El mockup cinco es la página de configuración. Vive bajo settings,
sección operación, ítem modo descanso. El layout sigue el patrón de
formulario standard del dashboard: tres tarjetas verticales, acciones a
la derecha abajo. La tarjeta uno tiene el toggle activo slash inactivo,
los dos campos de hora con tipografía monospace para evitar saltos
visuales, el selector de zona horaria con default Buenos Aires, y los
siete pills de días de la semana, todos seleccionables independientemente.
A la derecha del formulario hay un preview en vivo del countdown, así el
operador ve el efecto de su configuración sin tener que guardar primero.
La tarjeta dos es read-only y muestra los skills clasificados como
determinísticos versus LLM, con la nota de que la lista es fuente de
verdad desde config.yaml, no editable desde la UI: esto cierra el vector
de seguridad A04 que pidió el agente security. La tarjeta tres muestra los
labels de bypass, también read-only. Y abajo, un toast verde de
confirmación que aparece cuando el operador guarda, dejando claro que la
configuración aplica con hot-reload, sin reinicio del pipeline.

El mockup seis es el banner persistente de alerta de consumo anómalo. Acá
hay tres niveles de información, leyéndolos de arriba a abajo. Primero, en
el header, una pill compacta con el porcentaje del exceso, mas doscientos
trece por ciento, para que el operador entienda la magnitud al primer
vistazo. Segundo, el banner persistente debajo del header, ocupando todo
el ancho, con el ícono del pico, el texto explicativo, los tres skills que
más consumieron, y un mini gráfico de las últimas veinticuatro horas que
muestra el pico contra el baseline punteado. Tercero, las acciones a la
derecha: un botón rosa que dice ya lo vi, para acuse manual; y un selector
de snooze con opciones una hora, cuatro horas, veinticuatro horas, donde
veinticuatro horas es el tope máximo, también pedido por security en el
vector A04.

Debajo del banner, un gráfico grande de consumo horario sobre todo el
ancho del contenido principal, mostrando la línea sólida de hoy contra la
punteada del rolling siete días. Una banda rosa atenuada marca la
tolerancia más menos cincuenta por ciento, que es el umbral default. El
pico del día pasa por encima de la banda y por eso disparó la alerta. A la
derecha del gráfico, un preview del mensaje de Telegram tal como llega al
celular del operador, con la nota explícita de que el contenido pasa por
lib slash redact punto js antes del envío, cumpliendo el criterio de
seguridad A09. Y abajo de todo, dos bloques de audit trail mostrando
exactamente qué se persiste en metrics-history.jsonl y en
rest-mode-audit.jsonl: el operador puede auditar después qué pasó, quién
lo cambió, cuándo, y por qué.

Tres decisiones que vale la pena destacar. Primero, el modo descanso usa
un color propio, no reusa morado de definición ni teal de qa, justamente
para que el operador sepa al toque cuándo el dashboard está modo descanso
y cuándo está mirando una lane. Segundo, el banner de alerta usa un rojo
distinto al danger puro: el danger es para fallos de pipeline, el
alert-anomaly es para gasto económico anómalo, dos cosas distintas que
ameritan dos colores distintos. Tercero, el preview del Telegram dentro
del mockup no es decorativo: muestra exactamente lo que el operador va a
ver en su celular, sanitizado, así pipeline-dev tiene una referencia
literal de cómo debe quedar el formato del mensaje.

Lo que viene. Pipeline-dev toma estos tokens, este sprite, y estos tres
mockups, y aplica el sistema en tres pull requests. El primero, modo
descanso con gating, persistencia y ui básica, usa los mockups cuatro y
cinco. El segundo, baseline horario y detector, no toca ui pero comparte
los tokens. El tercero, telegram más banner más acuse, usa el mockup seis
completo. Yo vuelvo en validación de cada uno a verificar que los assets
estén donde los dejé, y vuelvo en aprobación a revisar el video. Cualquier
duda estoy al pie del cañón.

## Addendum · issue 3230 — calendario semanal con N periodos por día

Tres meses después del PR-A original, Leo nos pidió un upgrade estructural:
una sola ventana por configuración era demasiado rígida. La gente del
operativo quiere distinguir siesta de noche, viernes corto de fin de
semana libre, y tener domingos enteros sin pipeline. El issue tres dos tres
cero rediseña el schema de `rest-mode.json` y, en consecuencia, fuerza
también el rediseño completo del form del dashboard. Yo entregué dos
mockups nuevos para que pipeline-dev no improvise.

El primero, mockup cinco actualizado, reemplaza al form viejo. En vez del
único bloque hora inicio más hora fin más siete checkboxes, ahora hay un
grid semanal con siete columnas, una por día. Cada columna tiene tres
elementos visuales: un header con el nombre del día y un contador chico
con la cantidad de periodos configurados; un listado vertical de periodos
con su rango horario en monoespaciada, un caption corto que indica
contexto, siesta, noche, cruce de medianoche, día completo, y un botón
equis para eliminar; y al pie un botón punteado con texto más periodo que
sirve para agregar un bloque nuevo. La columna del lunes está resaltada
con tinte indigo translúcido porque es el día que se está mirando, y
dentro de ella el primer periodo, trece a dieciséis, está pintado en
indigo macizo con un puntito verde pulsante para indicar que el modo
descanso está activo en este momento. El sábado tiene una placeholder
discreta, un círculo gris con la leyenda sin descanso, día libre completo,
para que el operador entienda que ese día no hay restricción. El domingo
muestra el caso de día completo, cero cero a veintitrés cincuenta y nueve,
con tinte indigo claro, demostrando que ese es el único caso permitido
donde inicio igual a fin tiene sentido. El jueves muestra un estado
adicional, periodo en edición, con el borde resaltado en cian y un cursor
parpadeando dentro del input, más una tarjeta inline debajo que avisa que
mientras el operador esté editando, el polling de ocho segundos queda
pausado para no pisarle el cambio.

El segundo, mockup cinco be, es un complemento que muestra los cuatro
estados de error de validación de cliente que el pipeline tiene que
implementar. Cuatro tarjetas en fila. La primera, solapamiento entre dos
periodos del mismo día, lunes trece a dieciséis y catorce treinta a
dieciocho, ambos marcados en rojo con un tooltip explicativo. La segunda,
cross midnight overlap, martes veintidós a siete cruzando medianoche
contra un matinal seis a ocho, los dos en rojo porque el periodo nocturno
incluye al matinal cuando se expande al día siguiente, este es el caso
trampa que cubre el requisito seguridad tres del análisis. La tercera,
inicio igual a fin, miércoles trece a trece marcado como inválido, con un
ejemplo válido al lado, cero cero a veintitrés cincuenta y nueve, en
indigo para enseñar la única excepción permitida. La cuarta, cap de
veinticuatro periodos por día alcanzado, ámbar warning con el botón más
periodo deshabilitado, este es el control anti denegación de servicio que
pidió seguridad dos. Abajo, una barra de acciones con un contador rojo de
tres errores y el botón guardar deshabilitado mientras quede algún rojo
sin resolver. Y al pie de todo, un timeline visual de veinticuatro horas
del lunes con dos bandas indigo representando los dos periodos
configurados y una línea cian con el marcador ahora catorce veintitrés,
para que el operador vea geométricamente cómo queda el día.

Tres decisiones de diseño que vale la pena destacar para este addendum.
Primero, el header pill del dashboard cambia de modo descanso veintitrés
cero cero a cero siete cero cero, formato viejo, a activo, dos periodos
hoy, próximo veintidós a siete, formato nuevo. La diferencia es semántica,
ahora el operador ve cuántos bloques aplican hoy y cuál es el siguiente,
no la ventana cruda. Segundo, los periodos que cruzan medianoche se
identifican con el ícono de luna chico al costado y el caption más un día,
para que sea visualmente obvio que ese bloque se extiende al día
siguiente. Tercero, la validación de cliente, todas las tarjetas del
mockup cinco be, vive en un helper compartido entre cliente y servidor,
lib barra rest mode schedule punto js, así no duplicamos lógica de
detección de solapamientos. La nota técnica al pie del mockup lo recuerda
explícitamente, validación cliente es uxe, el backend revalida igual,
seguridad nueve.

Lo que viene esta vez. Pipeline-dev toma estos dos mockups nuevos más el
addendum, refactoriza rest mode window punto js para soportar el schema
con esquedule por día, actualiza el endpoint post barra api barra rest
mode para aceptar el payload nuevo manteniendo retrocompat con el viejo,
reemplaza el form del dashboard por el grid semanal, y agrega tests para
todos los casos de error que dibujé en cinco be. Yo vuelvo en validación
a verificar que los assets están donde los dejé y que el grid renderiza
bien con datos reales, y vuelvo en aprobación a revisar el video del qa.
