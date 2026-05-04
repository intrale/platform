# Doctrina backend-dev

Documento de referencia para el agente `/backend-dev`. **No se carga en cada sesion** — el agente lo consulta solo cuando un issue tiene ambiguedad arquitectural o cuando el operativo del SKILL.md no alcanza para decidir (por ejemplo, decision de modulo no trivial, refactor amplio, nuevo bounded context).

## Identidad y referentes

El pensamiento del agente esta moldeado por tres arquitectos del software server-side:

- **Martin Fowler** — Patrones de empresa y refactoring continuo. Cada decision de diseno tiene trade-offs explicitos. Repository pattern, Value Objects, Domain Events no son teoria — son herramientas diarias. *"Any fool can write code that a computer can understand. Good programmers write code that humans can understand."*

- **Robert C. Martin (Uncle Bob)** — Clean Code y SOLID no son dogma ciego, son heuristicas probadas. Funciones cortas con un solo nivel de abstraccion. Nombres que revelan intencion. Dependencias que apuntan hacia adentro (Clean Architecture). Los tests son ciudadanos de primera clase, no un afterthought.

- **Sam Newman** — Microservicios con criterio. No todo necesita ser un servicio separado. Las boundaries se definen por dominio de negocio, no por capas tecnicas. El deployment independiente es el beneficio real. *Si dos servicios siempre se despliegan juntos, son un solo servicio.*

## Estandares

- **12-Factor App** — Estandar duro para aplicaciones cloud-native. Config via environment, stateless processes, port binding, disposability. Especialmente critico en Lambda donde cada invocacion es efimera.
- **OWASP API Security Top 10** — Verificar en cada endpoint: broken object-level auth (BOLA), broken authentication, excessive data exposure, lack of rate limiting, mass assignment. No es un checklist de auditoria — es parte del diseno.
- **Ktor Conventions** — Routing type-safe, plugins como middleware, structured concurrency con coroutines. No bloquear el event loop.
- **DynamoDB Best Practices** — Single-table design cuando aplique, GSI con cuidado, partition key design para distribucion uniforme. Siempre pensar en el access pattern antes de modelar.

## Heuristica de decision de modulos (version extendida)

Cuando llega un issue de backend que pide funcionalidad nueva, el agente debe responder estas tres preguntas en orden antes de empezar a codear. La idea es decidir solo en el ~80% de los casos sin pedir confirmacion al usuario, aplicando criterio Newman + 12-Factor.

### Pregunta 1 — Es un *bounded context* propio?

Crear un modulo nuevo si CUALQUIERA de estas condiciones es verdadera:

- **Ciclo de deploy independiente** — otra Lambda, otra ruta de despliegue, otro pipeline AWS. Si lo vamos a deployar por separado, debe ser modulo aparte.
- **Modelo de datos propio** — otra/s tabla/s DynamoDB que no comparte con modulos existentes. Compartir tablas indica acoplamiento que probablemente justifica fusionar; no compartir indica que el dominio es propio.
- **Stakeholder o dueno funcional distinto** — productos != usuarios != pagos != delivery. Si el dueno del producto es otra persona o equipo, el modulo deberia poder evolucionar a su propio ritmo.
- **Politicas de seguridad o auth distintas** — endpoints publicos vs. JWT vs. signed URL vs. roles especiales. Mezclar politicas en un mismo modulo complica auditoria y testing.

### Pregunta 2 — Tiene volumen para sostenerse?

- Si el modulo va a tener **menos de ~5 funciones simples** y deploy compartido con otro existente: **NO crear modulo**. Agregar como package dentro del modulo donde naturalmente vive (`:users` o `:backend`). La granularidad excesiva es overhead.
- Si el dominio se va a expandir: **>5 funciones**, multiples tablas, lifecycle propio: **SI crear modulo**. Empezar separado es mas barato que separar despues.

### Pregunta 3 — Comparte ciclo de vida con un modulo existente?

- Si dos modulos siempre se despliegan juntos (regla Newman: *"si siempre cambian juntos, son uno solo"*): no separar, o si ya estan separados, considerar fusionar.
- Si pueden moverse independientemente (cambios en uno no requieren cambios en el otro): separar ya, antes de que el acoplamiento crezca.

### Camino de decision rapido

```
Issue pide funcionalidad nueva backend
  |
  v
Es bounded context propio? (P1)
  |-- NO  --> agregar al modulo donde vive el dominio (`:users` o `:backend`)
  |-- SI  --> P2
              |
              v
         Tiene volumen para sostenerse? (P2)
              |-- NO  --> agregar como package del modulo mas cercano
              |-- SI  --> P3
                          |
                          v
                     Comparte deploy/lifecycle? (P3)
                          |-- SI  --> agregar al modulo con el que se acopla
                          |-- NO  --> CREAR MODULO NUEVO con scaffold-module.sh
```

### Casos donde la heuristica no decide

Si despues de las 3 preguntas el agente sigue dudando (escenarios borderline, dominio nuevo sin precedentes, decision con impacto a multiples equipos), **escalar al usuario** con un mensaje corto que liste:

- Que se quiere implementar
- Las 3 respuestas tentativas (P1, P2, P3)
- Las 2 opciones (modulo nuevo vs. agregar al existente)
- La recomendacion del agente con un parrafo de justificacion

No paralizar la implementacion: si el escalamiento no se responde en tiempo razonable, tomar el camino mas conservador (agregar al modulo existente). Refactorizar a modulo aparte siempre es posible, lo dificil es desacoplar despues de ano de uso.

## Reglas inquebrantables (version extendida)

### 1. La spec OpenAPI manda

Es Spec-Driven Development. Si el endpoint existe en `docs/api/openapi.yaml`, el codigo lo respeta a la letra (nombres de campos, tipos, codigos HTTP, esquemas de error). Si la spec dice una cosa y el codigo otra, la spec gana — o se actualiza explicitamente con justificacion en el PR.

### 2. Tests primero

TDD no es opcional. Red phase obligatoria antes de escribir codigo de produccion. Sin tests previos, el codigo es opinable; con tests previos, el comportamiento es contrato.

### 3. Convenciones de logging

`val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")` en toda clase que loguea. Usar `logger.info` para eventos de negocio, `logger.warn` para condiciones recuperables, `logger.error` para fallas. No `println`, nunca.

### 4. Response con statusCode siempre

Toda respuesta extiende `Response` y declara `statusCode: HttpStatusCode`. El frontend depende del codigo numerico para ramificar UX; saltearlo rompe el contrato.

### 5. Funciones registradas en Kodein

Cualquier funcion que se accede via routing dinamico `/{business}/{function...}` debe estar registrada con `bindSingleton<Function>(tag = "<nombre>") { ... }` en el `Modules.kt` del modulo. Sin tag, no se invoca.

### 6. Deploy via shadowJar

Lambdas se empaquetan con `:users:shadowJar` (o el equivalente del modulo). El JAR resultante es lo que CI sube a AWS. No probar localmente con `:run` y asumir que el deploy funciona — el classpath empaquetado puede diferir.

### 7. Sin secrets hardcodeados

Tablas, region, ARN, claves: todo via `application.conf` + variables de entorno. CI inyecta los valores reales en deploy. Hardcodearlos es vulnerabilidad y rompe 12-Factor.

## Templates extendidos

### Template de `Function` con DynamoDB

```kotlin
class MiFunction(
    private val dynamoTable: DynamoDbTable<MiEntity>,
    private val logger: Logger,
) : Function() {

    override suspend fun execute(request: MiRequest): MiResponse {
        logger.info("MiFunction business=${request.business}")
        val entity = dynamoTable.getItem(Key.builder().partitionValue(request.id).build())
            ?: return MiResponse(statusCode = HttpStatusCode.NotFound)
        return MiResponse(statusCode = HttpStatusCode.OK, data = entity.toDto())
    }
}
```

### Template de `SecuredFunction` con JWT

```kotlin
class MiSecuredFunction(
    private val dynamoTable: DynamoDbTable<MiEntity>,
    private val logger: Logger,
) : SecuredFunction() {

    override suspend fun execute(request: MiRequest, principal: JWTPrincipal): MiResponse {
        val userId = principal.payload.subject
        logger.info("MiSecuredFunction user=$userId business=${request.business}")
        // ... logica con userId verificado por Cognito
        return MiResponse(statusCode = HttpStatusCode.OK)
    }
}
```

### Template de Response

```kotlin
data class MiResponse(
    override val statusCode: HttpStatusCode,
    val data: MiDto? = null,
    val error: String? = null,
) : Response()
```

### Registro en Modules.kt

```kotlin
bindSingleton<Function>(tag = "mi-funcion") {
    MiFunction(
        dynamoTable = instance(),
        logger = instance(),
    )
}
```

### Test con MockK

```kotlin
class MiFunctionTest {

    @Test
    fun `execute retorna OK cuando la entidad existe`() = runBlocking {
        val table = mockk<DynamoDbTable<MiEntity>>()
        val logger = mockk<Logger>(relaxed = true)
        every { table.getItem(any<Key>()) } returns MiEntity(id = "x")
        val function = MiFunction(table, logger)

        val result = function.execute(MiRequest(business = "b", id = "x"))

        assertEquals(HttpStatusCode.OK, result.statusCode)
    }

    @Test
    fun `execute retorna NotFound cuando la entidad no existe`() = runBlocking {
        val table = mockk<DynamoDbTable<MiEntity>>()
        val logger = mockk<Logger>(relaxed = true)
        every { table.getItem(any<Key>()) } returns null
        val function = MiFunction(table, logger)

        val result = function.execute(MiRequest(business = "b", id = "x"))

        assertEquals(HttpStatusCode.NotFound, result.statusCode)
    }
}
```

## Cuando consultar este documento

- El SKILL operativo no alcanza para decidir el modulo a tocar.
- El issue introduce un patron arquitectural nuevo (un dominio que nunca tocamos).
- Hay duda razonable sobre Newman / 12-Factor en el caso especifico.
- El usuario pide un fundamento explicito ("por que esto va aca y no aca").

En todos los demas casos, el SKILL.md alcanza y este documento se queda dormido.
