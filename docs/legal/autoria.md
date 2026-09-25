# Autoría humana de los cambios hechos con IA

> **En resumen**
> 1. En Intrale, el código lo escriben herramientas de IA **por encargo y bajo la dirección de una persona**, el operador.
> 2. Cada cambio que entra a la rama principal lleva un registro que dice de qué tarea salió, qué herramientas asistieron y si el operador firmó.
> 3. A partir de ese registro se genera una **constancia** en PDF que se lee sin saber de programación.
> 4. La constancia prueba con solidez que los registros no se tocaron después de integrarse. **No prueba por sí sola** que la firma la haya dado la persona indicada.
> 5. Hoy la verificación de firma funciona en **modo de prueba**, así que las constancias reales dicen "0 de N cambios con firma". Es lo esperado y no indica un error.

## Glosario

| Término | Qué significa |
|---|---|
| **Commit** | Un cambio guardado en el historial del código, con fecha y un identificador único. |
| **PR** (Pull Request) | La propuesta de cambio que se revisa antes de integrarla al código principal. |
| **Rama principal** (`main`) | La versión oficial del código. Lo que está ahí es lo que se usa. |
| **Trailer** | Las últimas líneas del mensaje de un commit, con datos estructurados. Ahí va el registro de autoría. |
| **Hash** (huella) | Un código que se calcula a partir de un contenido. Si el contenido cambia, la huella cambia. |
| **Gate** | Un punto de control donde el operador firma antes de que el trabajo siga. |

## ¿Qué cuenta como dirección humana?

Cuenta como dirección humana una **decisión del operador que quedó registrada y anclada al cambio**. Hay tres tipos:

| Tipo | Qué hizo la persona |
|---|---|
| Firma de aceptación (GATE 2) | Firmó la aceptación del código: revisó el resultado y aceptó que se integre. |
| Firma de definición (GATE 1) | Firmó la definición de la tarea: decidió qué había que hacer y con qué criterios. |
| Aprobación por el canal de firma | Aprobó por el canal de firma del operador. |

A esto se suma el trabajo que la persona hace siempre, aunque no deje firma: pedir la tarea, elegir qué se construye y en qué orden, y rechazar o reencauzar lo que no sirve.

## ¿Qué no cuenta?

- **Los pedidos de firma que el pipeline manda por su cuenta.** En el registro aparecen como entradas `*_request` (por ejemplo, `approval_channel_request`): son preguntas, no respuestas. Un pedido sin respuesta no es una decisión humana.
- **Lo que una herramienta de IA declara sobre sí misma** (por ejemplo, un `Co-Authored-By` escrito por el modelo). El registro de autoría lo arma el código del pipeline desde sus propios datos, nunca desde el texto que escribe la IA.
- **Registros escritos a mano o fuera de lugar.** Si el bloque de autoría de un commit está repetido, fuera del último párrafo o con un formato desconocido, el cambio se muestra como "Trailer inválido" o "Sin firma registrada" y no suma a la cuenta.

## ¿Por qué esta evidencia sostiene la autoría?

Tanto en **Estados Unidos** (criterio de la Oficina de Derechos de Autor para obras hechas con IA) como en **Argentina** (Ley 11.723, que protege la obra como expresión de una persona), lo que se protege es el **aporte humano**: la dirección, la selección y el arreglo que hace una persona, no el texto que produce una máquina por sí sola.

La constancia documenta justamente ese aporte, cambio por cambio:

1. **Se definió qué había que hacer**: la tarea de origen, con su título.
2. **Herramientas de IA escribieron y revisaron el código**: cuáles y con qué rol.
3. **Una persona aceptó el resultado**: quién firmó, qué decidió y cuándo.
4. **Quedó sellado en la rama principal**: el registro, su fecha y el PR.

> Esta sección describe el criterio técnico con el que se arma la evidencia. No es asesoramiento legal: ante un reclamo concreto, la constancia se entrega a un abogado como respaldo.

## ¿Qué prueba y qué no?

La constancia lleva siempre esta leyenda: *"Esta constancia verifica la consistencia de los registros en `main`; no prueba por sí sola la autenticidad de la firma."*

| | Qué cubre | Qué tan fuerte es |
|---|---|---|
| **Integridad posterior al merge** | Que, una vez integrado el cambio, su registro de autoría (con la huella de la firma) quedó escrito en el historial público de GitHub con su fecha, y no se puede alterar sin dejar rastro. | **Fuerte.** Se puede verificar en cualquier momento contra la rama principal. |
| **Autenticidad de la firma** | Que la firma la haya dado efectivamente la persona indicada. | **Depende de otros elementos**: del canal de firma del operador (Telegram), del servidor donde corre el pipeline y de que hoy todas las acciones en GitHub se hacen **con la misma cuenta**, así que GitHub por sí solo no distingue a la persona de la herramienta automática. |

Cerrar la segunda parte requiere una identidad propia del pipeline y firmas criptográficas. Eso está planificado en #7410, #6451 y #6427. Hasta que esté, la constancia **no promete más** que lo que dice la tabla.

## ¿Cuánto tiempo se guarda?

- **El registro de autoría vive en la rama principal, sin plazo.** Viaja dentro de cada commit y se conserva mientras exista el historial del código.
- **El PDF no se guarda.** Es una vista derivada de ese registro y se **regenera a pedido**, en cualquier máquina que tenga el repositorio, aunque se pierda el servidor del pipeline.
- **No hay almacenamiento privado externo.** Hoy no existe, así que no se promete. El repositorio es público y la constancia sólo muestra datos que ya son públicos en él (logins, títulos de tareas, fechas y huellas).

## ¿Por qué hoy las constancias dicen "0 de N"?

La verificación de firma está en **modo de prueba**: el pipeline registra si hubo firma, pero no frena la integración si falta. Mientras siga así, lo normal es que las constancias reales digan **"0 de N cambios con firma"**, y cada tarjeta lo explica con su motivo:

| Motivo | Qué dice la tarjeta |
|---|---|
| Modo de prueba | Se integró mientras la verificación estaba en modo de prueba. |
| Anterior a la vigencia | Cambio anterior a la entrada en vigencia del registro de firma. |
| Sin firma válida | No hay una firma válida para este issue, o la última registrada es un rechazo. |

Cuando todos los cambios de una constancia están en esta situación, el propio PDF lo aclara en el resumen: *"Es lo esperado mientras la verificación de firma funciona en modo de prueba; no indica un error del documento."*

## ¿Cómo pido una constancia?

Desde una copia del repositorio actualizada (`git fetch origin`):

```bash
# Un PR ya integrado
node .pipeline/lib/authorship/cli.js export --pr 7651 --pdf

# Un rango de commits (los extremos son identificadores de commit o nombres de rama)
node .pipeline/lib/authorship/cli.js export --range 5052c08b3..origin/main --pdf
```

- La constancia se escribe en `.pipeline/tmp/authorship-export/`, una carpeta que **no se sube** al repositorio. Con `--out` se puede elegir una subcarpeta de ahí, y nada más.
- El comando **no envía** nada por Telegram ni por Drive: la constancia se entrega a mano.
- `--pdf` necesita el puppeteer de `docs/qa/node_modules`. Sin él se genera sólo el HTML, que se puede abrir e imprimir desde el navegador.
- Un rango admite hasta 200 cambios por constancia.

Ejemplos de referencia del formato: [export de un PR](../../.pipeline/assets/mockups/7633/export-autoria-pr.html) y [rango con todos los estados](../../.pipeline/assets/mockups/7633/export-autoria-rango.html).

---

### Sección técnica

- Formato del registro (trailer del squash, #7631): `Intrale-Issue`, `Intrale-Human-Direction` (`<login>; <ISO UTC>; gate2|gate1|approval:sha256:<hash>` o `none; <ISO UTC>; missing|chain-broken|anchor-mismatch|unmapped`) e `Intrale-AI-Assisted`.
- Parseo y validación: una sola implementación en `.pipeline/lib/authorship/trailer.js`, compartida por delivery, la verificación y el export.
- Export puro (datos → HTML): `.pipeline/lib/authorship/export-chain.js`. Copy único: `.pipeline/lib/authorship/labels-es.js`. Acceso a git/gh: `.pipeline/lib/authorship/git-source.js`. PDF: `.pipeline/lib/pdf-render-strict.js` (JavaScript deshabilitado, sin red, sin `--no-sandbox`).
- Fuente de datos: sólo el trailer en `main` y los títulos de GitHub. El export **no lee** el registro local de aprobaciones del servidor.
- Modo de la verificación y fecha de vigencia: bloque `authorship` de `.pipeline/config.yaml` (`gate_mode: dry-run`, `go_live_date`). Un commit sin bloque de autoría anterior a `go_live_date` sale como "anterior a la vigencia"; uno posterior, como "modo de prueba".
