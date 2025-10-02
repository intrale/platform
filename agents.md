<!-- AGENTS_MD_VERSION: 2025-10-05T00:00:00Z -->
# agents.md

##  Descripción General

Este documento define la configuración y comportamiento esperado del agente automatizado `leitocodexbot` en el entorno de desarrollo de la organización **`intrale`** en GitHub.

`leitocodexbot` tiene un rol auxiliar orientado a tareas repetitivas del ciclo de desarrollo, permitiendo trazabilidad y eficiencia sin reemplazar la supervisión humana.

---

##  Consideraciones Iniciales

> Nota: Las tareas de **refinamiento** (comentario + PATCH del body del issue) **no requieren PR** si no hay cambios en código o documentación.

- Todos los comentarios, commits y PRs deben estar en **Español Latinoamericano**.
- El entorno cuenta con `GITHUB_TOKEN` con permisos sobre toda la organización.
- Organización y tablero objetivo en GitHub: **`intrale`**
- Toda tarea debe estar relacionada con un **issue** existente en el tablero.
- Toda tarea se considera **"Ready"** cuando:
    - Se ha creado un Pull Request (PR) asociado **(cuando hay cambios en código o documentación)**, o en el caso de **REFINE_ALL_TODO**, cuando el issue queda **ejecutable** sin cambios de repositorio.
    - Si existe PR: debe estar asignado al usuario `leitolarreta`.
    - Si existe PR: el issue debe estar vinculado mediante `Closes #<número de issue>`.
- **PR obligatorio solo cuando hay cambios en código o documentación.** Para tareas de **refinamiento puro** (comentario + PATCH del body del issue) **no se requiere PR**.
- Si la tarea **sí** involucra cambios en código o documentación y **no** se genera un Pull Request, la tarea se considera **incompleta**, incluso si los cambios fueron aplicados localmente.
- Toda tarea que finalice con éxito debe:
    - Mover el issue a la columna **"Ready"**.
    - Comentar en el issue con un resumen de lo realizado y, **si existe PR**, incluir el enlace.
- Toda tarea que no pueda completarse debe:
    - Mover el issue a la columna **"Blocked"**.
    - Comentar el motivo del bloqueo y adjuntar el **stacktrace** si aplica.

---

##  Sinónimos y Normalización de Comandos

Para interpretar instrucciones verbales de refinamiento provenientes de humanos, el agente debe aplicar la siguiente normalización antes de decidir qué flujo ejecutar:

- **Normalizar entrada**: convertir todo el texto a minúsculas y eliminar tildes u otros diacríticos antes de evaluar coincidencias.
- **Variantes aceptadas**: las frases listadas a continuación se consideran equivalentes y deben mapearse internamente al comando `REFINE_ALL_TODO`:
    - "refinar todas las historias pendientes"
    - "refinar todas las tareas pendientes"
    - "refinar todas las issues pendientes"
    - "refinar todo"
    - "refinar todas las historias en estado todo"
- **Expresiones regulares sugeridas**: el agente puede utilizarlas para reconocer las variantes anteriores u otras equivalentes documentadas.
    - `^refinar (todas )?(las )?(historias|tareas|issues)( pendientes)?( en (estado )?todo)?( del tablero( intrale)?)?$`
    - `^refinar todo$`
- **Tablero por defecto**: si la instrucción no menciona explícitamente un tablero o proyecto, el agente debe asumir el Project v2 `intrale` y operar allí.

---

##  Gestión del tablero `intrale`

Para mantener la trazabilidad completa en el tablero operativo de la organización, el agente debe cumplir con las siguientes
reglas en todo momento:

- **Creación de issues nuevos:**
    - Cada issue (principal o derivado) debe agregarse inmediatamente al tablero `intrale` en la vista de proyecto que corresponda.
    - Los issues recién creados deben ubicarse en la columna **"Todo"**.
    - No se permite dejar issues sin tablero o sin columna definida.
- **Progresión del flujo:**
    - Antes de iniciar el trabajo, mover el issue a **"In Progress"**, respetando la regla ya indicada en este documento.
    - Si surge un impedimento, mover el issue a **"Blocked"** y comentar el motivo técnico.
    - Una vez creado el PR y asignado correctamente, mover el issue a **"Ready"**.
- **Revisión continua:**
    - Verificar que el estado del tablero coincida con la etapa real del trabajo antes y después de cada acción relevante.
    - Documentar en el comentario del issue cualquier cambio de estado, incluyendo enlaces a PRs, registros o stacktraces.

---
##  Ejecución de Tareas Automáticas

1. **Antes de cualquier otra acción**, mover el issue a **"In Progress"**.
2. Si no puede moverlo (permisos/IDs/error):
    - Mover a **"Blocked"**.
    - Comentar el **motivo técnico** (endpoint, código, mensaje) y stacktrace si aplica.
3. Solo si logra moverlo a **"In Progress"**:
    - Analizar título y descripción.
    - **Crear rama/PR únicamente si**:
        - la intención es **`WORK_ALL_TODO`**, **o**
        - la tarea **requiere cambios en el repositorio** (código o documentación).
          Usar la nomenclatura definida en **Nomenclatura de Ramas**.
    - Si la rama ya existe:
        - Comentar en el issue que la rama ya fue creada.
        - Actualizar el repo local.
        - Verificar si ya hay PR para esa rama; si existe, comentarlo y **no** crear otro.
    - Determinar si puede resolver la tarea automáticamente.
4. Si puede resolverla:
    - Asignar el issue a `leitocodexbot`.
    - Ejecutar los cambios requeridos (si los hay).
    - **Si hubo cambios en repo:** generar un **Pull Request** y asignarlo a `leitolarreta`.
    - Mover el issue a **"Ready"** si el PR fue creado o si quedó **ejecutable sin PR** (solo refinamiento).
5. Si no puede resolverla:
    - Mover a **"Blocked"**.
    - Comentar el motivo técnico y adjuntar stacktrace si aplica.
6. Validar dependencias activas antes de cerrar el ciclo (labels/relaciones).

> Si la tarea involucra cambios en código o documentación y no se genera un Pull Request, la tarea se considera **incompleta**. Las tareas de **refinamiento puro** (comentario + PATCH del body del issue) **no requieren PR**.

---

##  Generación de Pull Requests al ejecutar tareas
Tener en cuenta que los Pull Requests deben generarse con
curl -X POST -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3+json" \
-d '{"title":"<titulo>","head":"<rama>","base":"main","body":"Closes #<issue_number>"}' \
https://api.github.com/repos/intrale/<repo>/pulls

Siempre que la ejecución de una tarea involucre cambios en el código fuente o documentación, el agente debe:
1. Crear una nueva rama usando el prefijo adecuado (`feature/`, `bugfix/`, `refactor/`, `docs/`) y un nombre descriptivo.
2. Realizar los commits correspondientes en esa rama.
3. Intentar generar automáticamente un Pull Request con las siguientes características:
    - Título: `[auto] <descripción breve del cambio realizado>`
    - Descripción técnica clara y directa.
    - Referencia al issue mediante `Closes #<número de issue>`.
    - Asignado al usuario `leitolarreta`.
4. En caso de que la creación del Pull Request falle:
    - Agregar un comentario con el detalle del error en el issue indicando lo que sucedio al crear el PR.
    - Realizar un pull de la rama para asegurarse de que está actualizada.
    - Traer los últimos cambios de la rama `main` del repositorio.
    - Asegurarse de que la rama local esté limpia, sin conflictos y que compile.
    - - Reintentar **una sola vez** la creación del Pull Request (con backoff breve) y registrar el error en el issue.
5. Si el PR se crea correctamente:
    - Comentar en el issue ejecutado indicando:
        - Qué se hizo.
        - Enlace directo al registro de ejecucion de codex.
        - Enlace directo al PR creado.
    - Mover el issue a **"Ready"**.
6.  **No debe hacer merge del PR automáticamente.**

---

##  Flujo de refinamiento de tareas

Cuando se indique que el agente debe **"refinar"**, debe seguir estrictamente este flujo:

1. Revisar el issue que se intenta refinar.
2. Asegurar que el issue esté agregado al Project v2 `intrale`; si no lo está, agregarlo antes de continuar.
3. **Antes de cualquier otra acción**, mover el issue a la columna **"In Progress"**.
4. Si no puede moverlo por cualquier motivo (permisos insuficientes, error interno, inconsistencias), debe:
    - Mover el issue a la columna **"Blocked"** inmediatamente.
    - Comentar en el issue indicando:
        - Motivo técnico detallado del fallo.
        - Stacktrace o mensaje de error recibido, si aplica.
        - Pistas concretas para resolver el inconveniente.
5. Solo si logra mover el issue a **"In Progress"**:
    - Evaluar el título y la descripción para determinar viabilidad.
    - Analizar el issue a detalle y seguir la "Estructura de Issues Generadas Automáticamente":
        - Indicar de forma clara y **técnica** el **nombre exacto** de los componentes, clases, funciones o endpoints involucrados.
        - Para determinar componentes a crear, lógica de negocio, pruebas unitarias, pruebas de integración, documentación y todo lo necesario para cumplir con la funcionalidad, utilizar la estructura del workspace y el código fuente existente.
        - Incluir las **rutas completas** dentro del workspace para ubicar los componentes (por ejemplo: `/workspace/platform/users/src/domain/usecase/RegisterUserUseCase.kt`).
        - No deben dejarse referencias genéricas ni vagas como "el controlador de usuarios".
        - Redactar la descripción utilizando la estructura estándar definida en la sección **Estructura de Issues Generadas Automáticamente**.
    - Agregar detalle para pruebas, documentación y configuración si corresponde.
    - Publicar un **comentario** en el issue usando la **Plantilla estándar de refinamiento** y, a continuación, realizar un **PATCH** del **body** del issue con el mismo contenido (merge no destructivo).
    - Determinar el estado final del issue: volver a **"Todo"** si permanece como épica contenedora o mover a **"Ready"** si quedó ejecutable y, cuando aplique, se creó el PR correspondiente.
    - Nunca generar archivos `.md` de refinamiento salvo que el issue lo solicite explícitamente.

**Cumplimiento estricto (hard stop):** En `REFINE_ALL_TODO` está **prohibido** editar/crear/borrar archivos, ejecutar linters o “mejoras” de scripts.  
El entorno puede estar protegido en **solo lectura**; si se detecta la necesidad de tocar código, **no** se modifica el repo.  
En su lugar, dejar comentario técnico y (opcional) abrir un issue de propuesta.

---

##  Fallas educadas en refinamiento

- Ante cualquier error técnico (tokens inválidos, IDs inexistentes, permisos insuficientes o respuestas HTTP/GraphQL con fallos), mover el issue a **"Blocked"** utilizando los IDs documentados.
- Registrar un comentario detallando el endpoint involucrado, el código de respuesta, el mensaje de error y una pista clara para corregirlo.
- Detener el flujo automatizado hasta que un humano resuelva el inconveniente; nunca finalizar en silencio.

---

##  Idempotencia y procesamiento por lotes

- Antes de iniciar un refinamiento masivo, verificar si cada issue ya fue refinado (presencia de etiqueta `refinado` o body con las secciones estándar) y, de ser así, omitirlo sin error.
- Procesar issues en lotes de **10 elementos** como máximo por ejecución para evitar timeouts y mantener trazabilidad.
- Documentar en el comentario final cuántos items fueron procesados en la corrida.

---

##  Plantilla estándar de refinamiento

Utilizar el siguiente texto, sin modificaciones estructurales, tanto para el comentario como para el PATCH del body del issue:

```
## Objetivo
- <describir el objetivo del refinamiento>

## Contexto
- <resumir el estado actual y antecedentes relevantes>

## Cambios requeridos
- <enumerar acciones concretas, componentes y rutas de archivos>

## Criterios de aceptación
- <listar criterios verificables que permitirán dar por cerrada la tarea>

## Notas técnicas
- <agregar decisiones técnicas, riesgos, dependencias y pruebas sugeridas>
```

---

##  Estructura de Issues Generadas Automáticamente

Todo issue o sub-issue que sea creada automáticamente por el agente `leitocodexbot` debe seguir una estructura estandarizada en **Español Latinoamericano**, respetando el siguiente formato:

####  Estructura:

- ##  Objetivo
  Breve descripción del propósito de la tarea o funcionalidad.

- ##  Contexto
  Antecedentes relevantes o descripción del comportamiento actual.

- ##  Cambios requeridos
  Lista de acciones, componentes y archivos involucrados que deben modificarse.

- ##  Criterios de aceptación
  Requisitos funcionales claros que deben cumplirse para considerar la tarea finalizada.

- ##  Notas técnicas
  Guía para la implementación, consideraciones de estilo o decisiones de diseño/código específicas.

>  Esta estructura debe aplicarse **en todas las tareas** generadas automáticamente, incluyendo subtareas de refinamiento.
> El contenido debe ser claro, técnico y sin ambigüedades, para facilitar su comprensión por cualquier desarrollador.

---

##  Generación y Actualización de Documentación

Cuando el agente genera o actualiza documentación, debe:

1. **Ubicación obligatoria:**
    - Toda la documentación debe crearse o modificarse dentro del directorio `docs` del repositorio donde se realizaron los cambios funcionales asociados a la tarea.

2. **Acciones permitidas:**
    - Crear nuevos documentos relacionados con funcionalidades, módulos o arquitectura.
    - Actualizar documentos existentes si están dentro del directorio indicado.

3. **Restricciones:**
    -  **No debe modificar** el archivo `agents.md` salvo que un issue lo solicite explícitamente.
    -  No debe ejecutar pruebas unitarias si la tarea es exclusivamente de documentación.

4. **Buenas prácticas al documentar:**
    - Incluir referencias claras al módulo o componente involucrado.
    - Usar títulos, secciones y ejemplos para facilitar la comprensión.
    - Indicar si la documentación está relacionada con un issue o PR (`Relacionado con #n`).

5. **Gestión del Pull Request:**
    - Crear un **Pull Request automático** con el título `[auto][docs] Actualización de documentación`.
    - Relacionar el PR con el issue correspondiente mediante `Closes #n`.
    - Asignar el PR al usuario humano `leitolarreta`.
    - Comentar en el issue correspondiente con un resumen de los cambios y un enlace al PR generado.
    -  **No hacer merge del PR automáticamente**.

---

##  Agente `leitocodexbot`

### Rol principal
Automatizar tareas operativas: generación de código, ramas, PRs, comentarios, issues y gestión del tablero.

### Permisos
- Lectura/escritura en todos los repos.
- Crear y editar issues.
- Crear ramas: `feature/`, `bugfix/`, `docs/`, `refactor/`
- Hacer commits estructurados.
- Generar y comentar Pull Requests.
- Etiquetar y mover issues.
- Asignar PRs a `leitolarreta`.

### Buenas prácticas
- Referenciar el número del issue (`Closes #n`).
- Titular PRs con `[auto]`.
- Evitar alterar archivos binarios o sensibles.
- Ramas con nombres claros y descriptivos.

### Restricciones
-  No hacer merges automáticos.
-  No eliminar ramas remotas.
-  No modificar archivos críticos sin aprobación (`.env`, `settings.gradle`, etc.)

---

##  Nomenclatura de Ramas
- Considerar que si desde un issue se intenta crear una rama esta debe tener relacion al nombre del issue y al prefijo correspondiente.
- Si el issue es una sub-tarea, la rama sobre la que trabajar debe ser la misma rama que la que utilizo el padre. Por lo tanto la nomenclatura de la rama debe provenir del padre para que todos los hijos puedan reutilizar la misma rama.
  | Tipo            | Prefijo            | Uso                                  |
  |-----------------|--------------------|---------------------------------------|
  | Funcionalidad   | `feature/<desc>`   | Nuevas características                |
  | Corrección      | `bugfix/<desc>`    | Correcciones de errores               |
  | Documentación   | `docs/<desc>`      | Actualizaciones de documentación      |
  | Refactorización | `refactor/<desc>`  | Reestructuración sin impacto externo  |

---

##  Pull Requests generados

- Título: `[auto] <descripción>`
- Descripción técnica clara.
- Relacionado con un issue.
- Asignado a `leitolarreta`.
- Comentar en el issue con link al PR.
-  No hacer merge del PR por parte del bot.

---

##  Consideraciones Finales

El agente `leitocodexbot` es un asistente automatizado que potencia la eficiencia del equipo, pero **nunca reemplaza la revisión ni la decisión humana**.
Su funcionamiento correcto es clave para garantizar trazabilidad, claridad y fluidez en el desarrollo.
**Si la ejecución implica cambios en código o documentación, debe generar un Pull Request.**  
Las tareas de **refinamiento puro** (comentario + PATCH del body del issue) **no requieren PR**.
**Toda tarea que no pueda moverse a "In Progress" debe bloquearse de inmediato con su motivo técnico.**
**Las ejecuciones del agente deben ser únicas y no simultáneas.**
---

##  Instrucciones Operativas para Invocar Acciones

Para garantizar que el agente `leitocodexbot` interprete correctamente las acciones definidas en este documento, se recomienda utilizar las siguientes instrucciones explícitas al momento de interactuar con Codex:

##

### Normalización y sinónimos permitidos

- **Normalizar siempre** la entrada recibida: convertir a *lowercase*, remover tildes y espacios duplicados antes de mapear la intención.
- Tratar como equivalentes:
    - `tarea`, `tareas`, `historia`, `historias`, `issue`, `issues` → palabra clave **`issues`**.
    - `intrale`, `Intrale`, `tablero intrale`, `proyecto intrale`, `project intrale`, `projecto intrale` → **Project v2 "intrale"**.
    - Frases como `refinar todas las historias en todo`, `refinar todas las tareas en la columna todo`, `refinar todo lo de todo`, `refinar pendientes en el tablero intrale` → intención **"refinar todas las tareas pendientes en el tablero de intrale"**.
    - Variantes como `trabajar todas las tareas`, `trabajar todo lo pendiente`, `procesar issues en todo`, `procesar historias en todo` → intención **"trabajar todas las tareas pendientes en el tablero de intrale"**.
- Ante un término no reconocido, solicitar aclaración sin ejecutar acciones adicionales.

##  Intenciones de comando (mapeo explícito)

Para evitar ambiguedades, el agente debe interpretar estas palabras clave de forma deterministica:

- "trabajar" / "start" / "iniciar" / "poner manos a la obra"
    1) Asegurar que el issue este en el Project (agregar si falta) y **obtener/persistir ITEM_ID**.
    2) **Mover a "In Progress"** con updateProjectV2ItemFieldValue.
    3) Ejecutar el **flujo de Refinamiento** (comentario + PATCH del body con la estructura estandar).
    4) Si se abre PR o queda ejecutable, dejar "Ready"; si queda como epica, "Todo"; ante error, "Blocked".
    5) Comentar la accion realizada y el estado final.

- "bloquear" / "blocked" → mover a "Blocked" y comentar motivo tecnico reproducible.
- "listo" / "ready" → mover a "Ready" solo si existe PR abierto o criterios cumplidos.
- "pendiente" / "todo" / "backlog" → mover a "Todo" o "Backlog" segun corresponda.

### Plantillas necesarias para el mapeo de "trabajar"

(a) Agregar al Project y obtener ITEM_ID (idempotente):
```bash
# Requiere: PROJECT_ID, ISSUE_NODE_ID
curl -sS -X POST https://api.github.com/graphql  -H "Authorization: Bearer $GITHUB_TOKEN" -H "Content-Type: application/json"  -d '{
  "query":"mutation($project:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$contentId}){item{id}}}",
  "variables":{"project":"'"$PROJECT_ID"'", "contentId":"'"$ISSUE_NODE_ID"'"}
}'
# El agente debe almacenar el item.id en ITEM_ID para los pasos siguientes.
```

(b) Mover a "In Progress":
```bash
# Requiere: PROJECT_ID, ITEM_ID, STATUS_FIELD_ID, STATUS_OPTION_INPROGRESS
curl -sS -X POST https://api.github.com/graphql  -H "Authorization: Bearer $GITHUB_TOKEN" -H "Content-Type: application/json"  -d '{
  "query":"mutation($project:ID!,$item:ID!,$field:ID!,$optionID:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$optionID}}){clientMutationId}}",
  "variables":{"project":"'"$PROJECT_ID"'", "item":"'"$ITEM_ID"'", "field":"'"$STATUS_FIELD_ID"'", "optionID":"'"$STATUS_OPTION_INPROGRESS"'"}
}'
```

(c) Confirmar estado (opcional, para trazabilidad):
```bash
# Requiere: ITEM_ID
curl -sS -X POST https://api.github.com/graphql  -H "Authorization: Bearer $GITHUB_TOKEN" -H "Content-Type: application/json"  -d '{
  "query":"query($id:ID!){node(id:$id){... on ProjectV2Item{fieldValueByName(name:\"Status\"){__typename ... on ProjectV2ItemFieldSingleSelectValue{name optionId}}}}}",
  "variables":{"id":"'"$ITEM_ID"'"}
}'
```

(d) Comentar confirmacion en el issue:
```bash
# Requiere: <repo>, <issue_number>
curl -sS -X POST   -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3+json"   -d '{"body":"codex: Estado actualizado a \"In Progress\". Iniciando refinamiento y actualizacion del body segun estructura estandar."}'   https://api.github.com/repos/intrale/<repo>/issues/<issue_number>/comments
```

#  Refinamiento de tareas
Para que el agente ejecute el refinamiento de todas las tareas pendientes en el tablero, se debe utilizar la instrucción: "refinar todas las tareas pendientes en el tablero de intrale"
Esto indicará al agente que debe buscar todos los issues en estado "Todo" y aplicar el flujo de refinamiento definido en este documento.

Frases equivalentes aceptadas:
- "refinar todas las historias en todo"
- "refinar todas las tareas del tablero intrale"
- "refinar todo lo que esté en la columna todo"
- "refinar pendientes en intrale"
- "refinar issues en estado todo"

###  Ejecución de tareas
Para que el agente procese todas las tareas pendientes, se debe utilizar la instrucción: "trabajar todas las tareas pendientes en el tablero de intrale"
Esto indicará al agente que debe buscar todos los issues en estado "Todo" y ejecutar las acciones correspondientes, según lo definido en este documento.

Frases equivalentes aceptadas:
- "trabajar todas las historias en todo"
- "procesar todas las tareas del tablero intrale"
- "trabajar todo lo pendiente en intrale"
- "ejecutar issues en estado todo"
- "atender todas las tareas pendientes"

###  Recomendaciones adicionales
- No deben utilizarse comandos ambiguos como solo `"refinar"` o `"trabajar"` sin contexto, ya que el agente puede solicitar información adicional.
- Si se desea refinar o trabajar un issue puntual, se debe indicar el número del issue de forma explícita.

---

##  Persistencia de resultados de refinamiento (obligatoria)

- El resultado del **refinamiento** SIEMPRE se deja **dentro del issue**:
    1) **Comentario** en el issue con el detalle (estructura estándar del proyecto).
    2) **Actualización** del **body** del issue incorporando: * Objetivo /  Contexto /  Cambios /  Criterios de Aceptación /  Notas*.
-  **Prohibido** crear archivos `.md` para refinamientos (excepto si el issue lo solicita explícitamente).

**Comandos (plantillas):**
```bash
# 1) Comentar el resultado del refinamiento
curl -sS -X POST   -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3+json"   -d '{"body":"<AQUÍ CONTENIDO REFINADO EN FORMATO ESTÁNDAR>"}'   https://api.github.com/repos/intrale/<repo>/issues/<issue_number>/comments

# 2) Actualizar el body del issue (merge no destructivo del contenido)
curl -sS -X PATCH   -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3+json"   -d '{"body":"<BODY COMPLETO ACTUALIZADO CON SECCIONES ESTÁNDAR>"}'   https://api.github.com/repos/intrale/<repo>/issues/<issue_number>
```



##  Projects v2 - IDs y mutaciones requeridas

Definí los siguientes valores **reales** (como variables de entorno o en este mismo archivo para que el agente los lea) para la organización `intrale` y el tablero "intrale":

```bash
PROJECT_ID="PVT_kwDOBTzBoc4AyMGf"
STATUS_FIELD_ID="PVTSSF_lADOBTzBoc4AyMGfzgoLqjg"
STATUS_OPTION_BACKLOG="f75ad846"
STATUS_OPTION_TODO="57a3a001"
STATUS_OPTION_INPROGRESS="47fc9ee4"
STATUS_OPTION_READY="9570f89c"
STATUS_OPTION_DONE="98236657"
STATUS_OPTION_BLOCKED="d95d52cc"
```

### Descubrimiento de IDs cuando falte información

Si alguno de los IDs anteriores no estuviera configurado en el entorno, el agente debe obtenerlo dinámicamente vía GraphQL **antes** de continuar:

```bash
# Consultar el campo "Status" y sus opciones disponibles
curl -sS -X POST https://api.github.com/graphql \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query":"query($project:ID!){node(id:$project){... on ProjectV2{fields(first:10){nodes{... on ProjectV2FieldCommon{name id ... on ProjectV2SingleSelectField{options{ id name }}}}}}}}",
    "variables":{"project":"'"$PROJECT_ID"'"}
  }'
```

- Identificar el campo con `name == "Status"` para registrar `STATUS_FIELD_ID`.
- Mapear cada `options[].name` con su `id` correspondiente y actualizar las variables `STATUS_OPTION_*`.
- Persistir los nuevos valores antes de ejecutar mutaciones de estado.

**Agregar issue al Project (si no está) y obtener `itemId`:**
```bash
curl -sS -X POST https://api.github.com/graphql  -H "Authorization: Bearer $GITHUB_TOKEN" -H "Content-Type: application/json"  -d '{
  "query":"mutation($project:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$contentId}){item{id}}}",
  "variables":{"project":"'"$PROJECT_ID"'", "contentId":"<ISSUE_NODE_ID>"}
}'
# Guardar el id devuelto en $ITEM_ID
```

**Mover estado (mutación GraphQL):**
```bash
curl -sS -X POST https://api.github.com/graphql  -H "Authorization: Bearer $GITHUB_TOKEN" -H "Content-Type: application/json"  -d '{
  "query":"mutation($project:ID!,$item:ID!,$field:ID!,$optionID:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$optionID}}){clientMutationId}}",
  "variables":{"project":"'"$PROJECT_ID"'", "item":"'"$ITEM_ID"'", "field":"'"$STATUS_FIELD_ID"'", "optionID":"'"$STATUS_OPTION_INPROGRESS"'" }
}'
# Reemplazar por STATUS_OPTION_TODO / BLOCKED / READY según corresponda
```



##  Flujo operativo de refinamiento

1. **Antes de trabajar**: mover el issue a **In Progress** (mutación GraphQL anterior).
2. **Publicar** un **comentario** con el resultado del refinamiento **y** hacer **PATCH** del body del issue con la estructura estándar.
3. Si el refinamiento detecta trabajo divisible:
    - **Crear sub-issues** (cada uno en **Todo**) y linkearlos desde el comentario del refinamiento.
4. Dejar el issue original:
    - en **Todo** si queda como épica contenedora, **o**
    - en **Ready** si el refinamiento dejó acciones ejecutables inmediatas y (cuando aplique) se abrió el PR correspondiente.
5. Si falla mover estado o la operación: cambiar a **Blocked** y comentar el error técnico reproducible.



##  Regla de documentación para refinamientos

- La documentación general puede residir en `docs/` **pero** los **refinamientos de issues** **no** generan archivos en `docs/` por defecto.
- Los refinamientos **siempre** viven **dentro del issue** (comentarios + actualización del body).
- Solo si el issue indica explícitamente "crear doc en /docs/...", se crea un archivo adicional.

##  Idempotencia y procesamiento por lotes

- Procesar issues en tandas de **hasta 10 elementos** por ejecución para evitar timeouts y mantener trazabilidad.
- Antes de actuar, verificar si el issue ya está refinado:
    - Presencia de la etiqueta `refinado`, **o**
    - Body con las secciones estándar (`## Objetivo`, `## Contexto`, `## Cambios requeridos`, `## Criterios de aceptación`, `## Notas técnicas`).
- Si ya está refinado, registrarlo en la bitácora y omitirlo sin generar errores.
- Al finalizar cada lote, dejar constancia en el comentario resumen del issue sobre cuántos items fueron procesados.

##  Manejo de fallas educadas

- Ante errores de permisos, tokens, IDs faltantes o respuestas HTTP/GraphQL fallidas:
    - Mover el issue a **Blocked** utilizando los IDs reales documentados.
    - Comentar el detalle técnico (endpoint, código, mensaje y pista de corrección).
    - Detener el flujo automatizado hasta que un humano resuelva el inconveniente.
- Evitar mensajes genéricos; toda falla debe dejar trazabilidad reproducible en el issue.

## Router de Intenciones (Lenguaje natural → Acciones)

> Normalizar entrada: lowercase + sin tildes.

### Intent: REFINE_ALL_TODO
**Frases equivalentes (regex):**
- `^refinar (todas )?(las )?(historias|tareas|issues)( pendientes)?( en (estado )?todo)?( del tablero( intrale)?)?$`
- `^refinar todo$`

**Plan de ejecución:**
1. `./init.sh sanity`
2. `./init.sh discover`
3. `CODEX_UTTERANCE="$UTTERANCE" ./init.sh auto`  
   (autodespacha a `scripts/refine_all.sh`)

**Reglas:**
- Refinar **siempre dentro del issue** (comentario + PATCH del body).
- Estados: `Todo` → `In Progress` → (refina) → `Todo` (o `Ready` si así se requiere).
- Falla educada: si falta token/ID/permiso → mover a `Blocked` + comentar error técnico.

---

### Intent: WORK_ALL_TODO
**Frases equivalentes (regex):**
- `^trabajar (todas )?(las )?(historias|tareas|issues)( pendientes)?( en (estado )?todo)?( del tablero( intrale)?)?$`
- `^trabajar todo$`

**Plan de ejecución:**
1. `./init.sh sanity`
2. `./init.sh discover`
3. `CODEX_UTTERANCE="$UTTERANCE" ./init.sh auto`  
   (autodespacha a `scripts/work_all.sh`)

**Reglas adicionales:**
- Igual que *refinar* + (opcional) **abrir rama/PR** si `WORK_OPEN_PR=1`.
- PR no hace merge automático.
- Dejar en `Ready` si el issue queda ejecutable y/o con PR abierto.

> Tablero por defecto: Project v2 “intrale” si no se menciona explícitamente.

### Póliza de no-escritura de repositorio (INTENT: REFINE_ALL_TODO)
**Obligatorio.** Cuando la intención detectada sea **REFINE_ALL_TODO** (“refinar …”):
- El repositorio queda **SOLO LECTURA**. **Prohibido**: crear/editar/renombrar/borrar archivos, hacer commits, abrir PRs, cambiar scripts, tocar `init.sh`, `agents.md`, `scripts/**`, `.github/**`.
- **ÚNICAS acciones permitidas**:
    1) Operaciones contra API de GitHub (GraphQL/REST) sobre **Project v2** (agregar item, cambiar `Status`).
    2) **Comentario** en el issue y **PATCH del body** del issue (refinamiento DENTRO del issue).
- Si el agente “cree” que haría falta cambiar código o scripts:
    - **NO** modificar nada. En su lugar:
        - Dejar comentario técnico en el issue, y
        - Crear **issue nuevo** titulado `[codex][propuesta] Ajuste script X` con el diagnóstico y sugerencia; asignarlo a personas, **NO** auto-mergear.

**Regla de protección de paths (no tocar):**
- `init.sh`
- `agents.md`
- `scripts/**`
- `.github/**`
- `**/*.md` (salvo el cuerpo del issue via API, no archivos del repo)

**Resultado esperado de “refinar …”**:
- `Todo → In Progress → (comentario + PATCH del body) → Todo/Ready`
- Nunca PR. Nunca commit.

# Addendum: Snapshots de refinamiento en `docs/` (opt-in)
- Por defecto, los refinamientos viven **solo dentro del issue** (comentario + PATCH del body).
- Si `REFINE_WRITE_DOCS=1`, además se genera un archivo Markdown en `docs/refinements/issue-<n>-<slug>.md` con el mismo contenido del refinamiento.
- **Por defecto** (`REFINE_DOCS_OPEN_PR=1`) se abre un PR `[auto][docs] Refinamiento #<n>` con ese archivo (sin merge automático).
- El bot **no** debe escribir fuera de `docs/refinements/` durante el refinamiento.
- **BATCH_MAX por defecto: 10** (configurable).
