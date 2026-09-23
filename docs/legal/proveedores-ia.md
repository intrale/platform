# Política de proveedores de IA

> Qué ve cada proveedor de IA de nuestro **código**, nuestros **datos** y nuestro **entorno**, con qué fundamento, y para qué roles está habilitado.
>
> - **Fuente estructurada:** `.pipeline/provider-policy.json` (schema: `.pipeline/provider-policy.schema.json`).
> - **Reglas ejecutables:** `.pipeline/lib/provider-policy.js` (`canEnable`, `termsStatus`, `checkMatrixCoherence`).
> - **Origen:** #7597, parte del épico #7589.
>
> Este documento y el JSON tienen que decir lo mismo. Un test compara la tabla de respuesta rápida y la de diferencias abiertas contra el JSON, y falla si no coinciden (`provider-policy-coherence.test.js`).

## 1. Respuesta rápida

| Proveedor | Código | Datos | Entorno | Roles habilitados | Términos vencen |
|---|---|---|---|---|---|
| `anthropic` | escritura | issues, logs, telegram, qa_evidence, handoff | scopes: github, aws, gradle-android, telegram-hooks · FS: home del operador · permisos: bypass | backend-dev, pipeline-dev, android-dev, web-dev, security, qa, review, po, ux, doc, planner, guru, architect, ops, perf, auth, refinar, telegram-commander, telegram-sherlock | 15/12/2026 |
| `openai-codex` | escritura | issues, logs, telegram, qa_evidence, handoff | scopes: github, aws, gradle-android, telegram-hooks · FS: home del operador · permisos: bypass | backend-dev, pipeline-dev, android-dev, web-dev, security, qa, review, po, ux, doc, planner, guru, architect, ops, perf, auth, refinar, telegram-commander, telegram-sherlock | 15/12/2026 |
| `antigravity` | escritura | issues, logs, telegram, handoff | scopes: telegram-hooks · FS: home del operador · permisos: bypass | architect, perf, telegram-commander, telegram-sherlock | 15/12/2026 |

`deterministic` está **exento**: son scripts de Node sin modelo de lenguaje (`build`, `tester`, `linter`, `delivery`). No mandan nada a ningún proveedor externo, así que no hay nada que habilitar ni términos que verificar. Lo que puedan tocar lo acota el techo de credenciales por fase del pipeline, igual que al resto.

Vocabulario de la tabla:

- **Código:** `lectura`, `escritura` o `ninguno`. Es lo que el proceso del agente puede hacer con el repositorio, no sólo lo que el rol "debería" hacer.
- **Datos:** las categorías que el proveedor puede llegar a ver en algún rol habilitado. El detalle por rol está en la sección de cada proveedor.
- **Entorno:** qué credenciales recibe el proceso (por *categoría* de credencial, nunca por nombre), hasta dónde llega en el disco y con qué modo de permisos corre el CLI.

## 2. ¿Puedo habilitar el proveedor X para el rol Y?

Se responde con `canEnable(X, Y)` de `.pipeline/lib/provider-policy.js`. Las preguntas son estas cinco, en este orden, y la función devuelve exactamente estas frases cuando la respuesta es "no":

1. ¿El proveedor tiene entrada en la política? Si no: *"El proveedor X no tiene entrada en la política: se trata como prohibido."*
2. ¿El rol está en `roles_allowed` del proveedor? Si no: *"El rol Y no está habilitado para X en la política."*
3. ¿La habilitación tiene sign-off del operador (link a su comentario)? Si no: *"La habilitación de Y en X no tiene sign-off del operador."*
4. ¿Cada credencial que recibe el rol está permitida para el proveedor? Por cada una que no: *"El rol Y recibe el scope S, que X no tiene permitido."*
5. ¿Los términos del proveedor están vigentes? Si no: *"Los términos de X están vencidos (DD/MM/AAAA): no se aceptan habilitaciones nuevas."*

Las credenciales del punto 4 **no se escriben a mano en la política**. Salen de la configuración de cada rol en el pipeline (lo que declara en `agent-models.json` o, si no declara nada, su default en `lib/build-child-env.js`). Si un rol empieza a pedir una credencial nueva, la respuesta cambia sola.

**Cómo se habilita, entonces:** el operador firma en un comentario de GitHub → el PR agrega el rol a `roles_allowed` con el link a esa firma **y** suma el eslabón a `agent-models.json` en el mismo cambio. El test de coherencia no deja que uno quede sin el otro.

## 3. Proveedores

### 3.1 `anthropic`

**Código.** Escritura. Es el primario de todos los roles con modelo de lenguaje: lee el repositorio completo y escribe código que llega a `main` por PR. El repo es público, así que la confidencialidad del código no es el argumento central; lo que importa es la **integridad** de `main` y lo que el proceso alcanza del entorno (abajo).

**Datos.**

| Categoría | ¿Puede verla? | Roles |
|---|---|---|
| Issues y PRs | sí | todos los habilitados |
| Logs del pipeline | sí | todos los habilitados |
| Conversaciones del operador por Telegram (texto y audio transcrito) | sí | todos los habilitados (en la práctica, `telegram-commander` y `telegram-sherlock`) |
| Evidencia de QA (videos y capturas, con datos de usuarios de prueba) | sí | todos los habilitados (en la práctica, `qa`, `po`, `ux`) |
| Handoff entre agentes | sí | todos los habilitados |

**Entorno.**

- **Variables recibidas:** credenciales de GitHub, de AWS del ambiente de QA, del toolchain de Android/Gradle y el destino de notificaciones de Telegram (sin el token del bot). Cada rol recibe sólo las que declara, y el techo por fase las recorta más.
- **Archivos alcanzables:** el directorio personal del operador. El agente corre con el usuario del operador, así que puede leer lo que ese usuario puede leer, incluidos los almacenes de credenciales de otros CLIs y otros worktrees.
- **Red y herramientas:** shell, red, `git`, `gh`, AWS CLI y Gradle.
- **Modo de permisos:** `bypass` (el CLI no pide confirmación por herramienta).

**Fundamento contractual.** [Términos comerciales](https://www.anthropic.com/legal/commercial-terms), [términos de consumidor](https://www.anthropic.com/legal/consumer-terms) y [DPA](https://www.anthropic.com/legal/dpa). Evaluado en el criterio de admisión del 2026-09-16 (#6562) como "términos sin entrenamiento". El CLI se autentica con la cuenta del operador (OAuth), no con una clave de organización: verificar qué términos aplican a ese tipo de cuenta es #7641.

**Roles habilitados.** Los 19 roles con modelo de lenguaje de la tabla 1. Firma: [sign-off de la matriz vigente](https://github.com/intrale/platform/issues/6860#issuecomment-5723188265) (#6860, 18/09/2026).

**Vencimiento.** Verificado el 16/09/2026 · vence el 15/12/2026.

### 3.2 `openai-codex`

**Código.** Escritura. Es el primer respaldo de casi todos los roles, incluidos los que escriben código: lee el repositorio y puede escribir código que llega a `main` por PR.

**Datos.**

| Categoría | ¿Puede verla? | Roles |
|---|---|---|
| Issues y PRs | sí | todos los habilitados |
| Logs del pipeline | sí | todos los habilitados |
| Conversaciones del operador por Telegram (texto y audio transcrito) | sí | todos los habilitados (en la práctica, `telegram-commander` y `telegram-sherlock`) |
| Evidencia de QA (videos y capturas, con datos de usuarios de prueba) | sí | todos los habilitados (en la práctica, `qa`, `po`, `ux`) |
| Handoff entre agentes | sí | todos los habilitados |

Recibe el repositorio **sin** los archivos que excluye el filtro de residencia de datos (`.pipeline/data-residency-exclusions.json`: archivos de entorno, almacenes de secretos, claves privadas, auditoría interna). Ese filtro aplica a todo proveedor que no sea Anthropic y esta política lo reusa, no lo duplica.

**Entorno.**

- **Variables recibidas:** las mismas categorías que `anthropic` (GitHub, AWS del ambiente de QA, toolchain de Android/Gradle, destino de Telegram), según lo que declare cada rol.
- **Archivos alcanzables:** el directorio personal del operador. El filtro de residencia sólo controla lo que el lanzador **manda** como contexto; no impide que el agente lea por su cuenta otros archivos con sus herramientas.
- **Red y herramientas:** shell, red, `git`, `gh`, AWS CLI y Gradle.
- **Modo de permisos:** `bypass` (sin aprobación por herramienta ni sandbox, por paridad con Claude).

**Fundamento contractual.** [Términos de negocio](https://openai.com/policies/row-business-terms/) y [DPA](https://openai.com/policies/data-processing-addendum/). Evaluado en el criterio de admisión del 2026-09-16 (#6562) como "términos sin entrenamiento". El CLI se autentica con la cuenta del operador (OAuth): verificar qué términos aplican a ese tipo de cuenta es #7641.

**Roles habilitados.** Los 19 roles con modelo de lenguaje de la tabla 1. Firma: [sign-off de la matriz vigente](https://github.com/intrale/platform/issues/6860#issuecomment-5723188265) (#6860, 18/09/2026).

**Vencimiento.** Verificado el 16/09/2026 · vence el 15/12/2026.

### 3.3 `antigravity`

**Código.** Escritura. El CLI edita archivos del worktree, aunque ninguno de los roles habilitados produce código que llegue a `main`. Recibe el repositorio sin los archivos excluidos por el filtro de residencia de datos.

**Datos.**

| Categoría | ¿Puede verla? | Roles |
|---|---|---|
| Issues y PRs | sí | architect, perf, telegram-commander, telegram-sherlock |
| Logs del pipeline | sí | perf |
| Conversaciones del operador por Telegram (texto y audio transcrito) | sí | telegram-commander, telegram-sherlock |
| Evidencia de QA (videos y capturas, con datos de usuarios de prueba) | no | — |
| Handoff entre agentes | sí | architect, perf |

Las conversaciones de Telegram están habilitadas por la **Decisión 1** firmada en #6860: el operador aceptó que el Commander y Sherlock ruteen por Antigravity con cuenta de consumidor, sabiendo que las interacciones se retienen y pueden ser revisadas por personas.

**Entorno.**

- **Variables recibidas:** sólo el destino de notificaciones de Telegram (sin el token del bot). Ninguna credencial de GitHub, AWS ni toolchain.
- **Archivos alcanzables:** el directorio personal del operador. No recibir la credencial por variable **no** impide leerla del disco si está al alcance del usuario. Este es el argumento fuerte para excluir a Antigravity de los roles con credenciales, más que la confidencialidad del código (el repo es público).
- **Red y herramientas:** shell, red y `git`.
- **Modo de permisos:** `bypass` (el CLI corre sin pedir permisos).

**Fundamento contractual.** [Términos de Antigravity](https://antigravity.google/terms), [FAQ](https://antigravity.google/docs/faq/) y [planes](https://antigravity.google/docs/plans/). Auditoría de security del 16/09/2026 (#6860): cuenta de consumidor, **no** se acredita ausencia de entrenamiento. Por eso sigue en el ruteo sólo bajo excepción de admisión y queda fuera de los roles con credenciales o que escriben a `main` (ver §4.4.1 de `docs/pipeline/multi-provider.md`). La re-verificación por **versión** del CLI es otro eje y la lleva #7343.

**Roles habilitados.** architect, perf, telegram-commander, telegram-sherlock. Firma: [sign-off de la matriz vigente](https://github.com/intrale/platform/issues/6860#issuecomment-5723188265) (#6860, 18/09/2026). `po` y `ux` están pendientes de firma (sección 4).

**Vencimiento.** Verificado el 16/09/2026 · vence el 15/12/2026.

## 4. Diferencias abiertas

Diferencias entre la matriz vigente (`agent-models.json`) y esta política que **no** están resueltas. La matriz no se toca hasta que el operador firme; el test de coherencia las acepta sólo si figuran acá y en `open_differences` del JSON, y falla ante cualquier otra.

| Proveedor | Rol | Scope | Pedido de firma |
|---|---|---|---|
| `antigravity` | po | github | [pedido](https://github.com/intrale/platform/issues/7597#issuecomment-5798076359) |
| `antigravity` | ux | github | [pedido](https://github.com/intrale/platform/issues/7597#issuecomment-5798076359) |

`po` y `ux` tienen a Antigravity como primer respaldo (Decisión 2 de #6860). En ese eslabón el proceso recibe la credencial de GitHub, que tiene escritura sobre el repo, y la política no le permite esa credencial a Antigravity. Opciones en el pedido: aceptarla con firma, sacar el eslabón o esperar a que #7598 la baje a sólo lectura.

Diferencias ya resueltas en esta versión:

- `architect` y `perf` en Antigravity: aceptadas. Sólo reciben el destino de Telegram; el alcance de disco y el modo de permisos quedan declarados arriba.
- `telegram-commander` y `telegram-sherlock` en Antigravity: aceptadas por la Decisión 1 de #6860.
- `android-dev`, `web-dev` y `qa` **sin** Antigravity: la política no los habilita y el test verifica que la matriz tampoco los rutee ahí.

## 5. Vencimiento de términos

- Cada proveedor declara `verified_at` y `expires_at` (máximo 120 días de vigencia). El vencimiento es **al terminar** el día de `expires_at` (UTC).
- Fecha ausente o inválida = **vencida**.
- Con los términos vencidos:
  - **No se aceptan habilitaciones nuevas** (`canEnable` responde que no).
  - **Los roles vigentes siguen ruteando.** Un trámite administrativo no puede cortar la cuota del pipeline; el vencimiento se ve, no corta.
  - El panel de proveedores muestra el chip **⚠ TÉRMINOS VENCIDOS** y el health-cron manda la alerta `terms_expired` por Telegram, con un recordatorio cada 24 h mientras siga vencido.
- Para cerrarlo: re-verificar los términos y actualizar `verified_at`, `expires_at` y `sources` en el JSON y la sección del proveedor en este documento, en el mismo PR.

## 6. Riesgos transversales

**Prompt injection (OWASP LLM01).** Los issues y PRs del repo son públicos: cualquiera puede escribir en ellos. Su contenido es **input no confiable** para todo proveedor con agencia (shell, red, permisos en `bypass`). Es un riesgo distinto al de confidencialidad: no se trata de qué ve el proveedor, sino de qué le pueden hacer hacer. Aplica a los tres proveedores y pesa más donde el proceso alcanza credenciales.

**Exposiciones conocidas.** La política declara la exposición real; el aislamiento del sistema de archivos es trabajo de ejecución y se sigue en sus issues:

| Proveedor | Issues |
|---|---|
| `anthropic` | #7041, #7316, #7641 |
| `openai-codex` | #7041, #7316, #7641 |
| `antigravity` | #7302, #7316, #7041, #7343 |

## 7. Historial y auditoría

El registro de quién habilitó o quitó un proveedor para un rol, cuándo y por qué sale del **historial de git** de `.pipeline/provider-policy.json`: autor, commit y fecha los pone git, y el "por qué" es el `signoff_ref` de cada habilitación. `lib/agent-models-change-alert.js` observa ese archivo, avisa por Telegram cada alta o baja y lo asienta en su registro de auditoría append-only. Ningún campo escrito por un agente cuenta como autoría.

Límite conocido: los comentarios de GitHub del pipeline se publican con la cuenta del operador, así que el autor del comentario no prueba por sí solo que la firma sea humana. La identidad autorizada para firmar sigue el modelo de `docs/pipeline/gates-firma-operador.md`; verificarlo en línea queda fuera del chequeo offline.

No se copia acá una tabla de cambios: se desincronizaría. Para verla, `git log -p -- .pipeline/provider-policy.json`.
