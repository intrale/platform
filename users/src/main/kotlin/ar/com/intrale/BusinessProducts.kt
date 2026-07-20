package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

class BusinessProducts(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    private val productRepository: ProductRepository,
    private val categoryRepository: CategoryRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando business/products para negocio=$business, function=$function")

        // Autorizacion por operacion (MUST 2): resolvemos el perfil una sola vez.
        // BUSINESS_ADMIN puede todo; SALER puede leer/crear/editar/pausar pero NO dar de baja.
        val adminProfile = requireApprovedProfile(cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN)
        val salerProfile = if (adminProfile == null) {
            requireApprovedProfile(cognito, headers, tableProfiles, business, PROFILE_SALER)
        } else null
        if (adminProfile == null && salerProfile == null) return UnauthorizedException()
        val isBusinessAdmin = adminProfile != null

        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()
        val productId = extractId(function)

        return when (method) {
            HttpMethod.Get.value.uppercase() -> handleGet(business, productId)
            HttpMethod.Post.value.uppercase() -> handlePost(business, textBody)
            HttpMethod.Put.value.uppercase() -> handlePut(business, productId, textBody)
            // Dar de baja es operacion destructiva: solo BUSINESS_ADMIN (MUST 2).
            HttpMethod.Delete.value.uppercase() ->
                if (isBusinessAdmin) handleDelete(business, productId)
                else UnauthorizedException()
            else -> RequestValidationException("Metodo no soportado: $method")
        }
    }

    private fun handleGet(business: String, productId: String?): Response {
        if (productId != null) {
            val product = productRepository.getProduct(business, productId)
                ?: return ExceptionResponse("Producto no encontrado", status = HttpStatusCode.NotFound)
            return ProductResponse(product = product.toPayload(), status = HttpStatusCode.OK)
        }
        val products = productRepository.listProducts(business)
        return ProductListResponse(products = products.map { it.toPayload() })
    }

    private fun handlePost(business: String, textBody: String): Response {
        val body = parseBody<ProductRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        val validationError = validateProductRequest(body)
        if (validationError != null) return validationError

        // En alta solo se permiten estados iniciales (DRAFT / PUBLISHED). PAUSED/INACTIVE
        // solo se alcanzan por operaciones explicitas (pausar / dar de baja) — MUST 5.
        val requestedStatus = resolveStatus(body.status) ?: return invalidStatusError(body.status)
        if (requestedStatus !in CREATABLE_STATUSES) {
            return RequestValidationException("Estado inicial no permitido: $requestedStatus")
        }

        val record = ProductRecord(
            name = body.name,
            shortDescription = body.shortDescription,
            basePrice = body.basePrice,
            unit = body.unit,
            categoryId = body.categoryId,
            status = requestedStatus,
            isAvailable = body.isAvailable,
            stockQuantity = body.stockQuantity,
            isFeatured = body.isFeatured,
            promotionPrice = body.promotionPrice
        )
        val saved = productRepository.saveProduct(business, record)
        logger.debug("Producto creado id=${saved.id} en negocio=$business")
        return ProductResponse(product = saved.toPayload(), status = HttpStatusCode.Created)
    }

    private fun handlePut(business: String, productId: String?, textBody: String): Response {
        if (productId == null) return RequestValidationException("ID de producto requerido")

        val body = parseBody<ProductRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        val validationError = validateProductRequest(body)
        if (validationError != null) return validationError

        // El producto se resuelve por (business del path, productId) — aislamiento de tenant (MUST 1).
        val existing = productRepository.getProduct(business, productId)
            ?: return ExceptionResponse("Producto no encontrado", status = HttpStatusCode.NotFound)

        // Whitelist de estados + transiciones legales (MUST 5). No se puede saltar la baja
        // (status=INACTIVE) via PUT: la baja es una operacion explicita y autorizada (MUST 3).
        val requestedStatus = resolveStatus(body.status) ?: return invalidStatusError(body.status)
        val transitionError = validateTransition(existing.status, requestedStatus)
        if (transitionError != null) return transitionError

        // id y businessId son server-authoritative: el repo los ignora del body (MUST 4).
        val record = ProductRecord(
            name = body.name,
            shortDescription = body.shortDescription,
            basePrice = body.basePrice,
            unit = body.unit,
            categoryId = body.categoryId,
            status = requestedStatus,
            isAvailable = body.isAvailable,
            stockQuantity = body.stockQuantity,
            isFeatured = body.isFeatured,
            promotionPrice = body.promotionPrice
        )
        val updated = productRepository.updateProduct(business, productId, record)
            ?: return ExceptionResponse("Producto no encontrado", status = HttpStatusCode.NotFound)
        logger.debug("Producto actualizado id=$productId en negocio=$business")
        return ProductResponse(product = updated.toPayload(), status = HttpStatusCode.OK)
    }

    private fun handleDelete(business: String, productId: String?): Response {
        if (productId == null) return RequestValidationException("ID de producto requerido")

        // Baja logica (MUST 3): cambia el estado a INACTIVE, nunca remueve fisicamente.
        // Idempotente y server-authoritative (no confia en confirmacion de UI).
        val discontinued = productRepository.discontinueProduct(business, productId)
            ?: return ExceptionResponse("Producto no encontrado", status = HttpStatusCode.NotFound)
        logger.debug("Producto dado de baja (logica) id=$productId en negocio=$business estado=${discontinued.status}")
        return NoContentResponse()
    }

    private fun validateProductRequest(body: ProductRequest): Response? {
        if (body.name.isBlank()) return RequestValidationException("El nombre es requerido")
        if (body.basePrice <= 0) return RequestValidationException("El precio base debe ser mayor a cero")
        val promotionPrice = body.promotionPrice
        if (promotionPrice != null && promotionPrice > body.basePrice) {
            return RequestValidationException("El precio de promocion no puede superar al precio base")
        }
        val stockQuantity = body.stockQuantity
        if (stockQuantity != null && stockQuantity < 0) {
            return RequestValidationException("El stock no puede ser negativo")
        }
        return null
    }

    /**
     * Resuelve el estado solicitado contra la whitelist server-side. Un string nulo/vacio
     * cae en el default DRAFT; cualquier valor fuera del whitelist retorna null (invalido).
     */
    private fun resolveStatus(status: String?): String? {
        val normalized = status?.trim()?.uppercase()
        if (normalized.isNullOrBlank()) return "DRAFT"
        return if (normalized in VALID_STATUSES) normalized else null
    }

    private fun invalidStatusError(raw: String?): Response =
        RequestValidationException("Estado de producto invalido: ${raw ?: "null"}")

    /**
     * Valida que la transicion de estado via PUT sea legal (MUST 5). La baja (INACTIVE)
     * NO es alcanzable por PUT: exige la operacion de baja autorizada (DELETE).
     */
    private fun validateTransition(current: String, requested: String): Response? {
        if (requested == "INACTIVE") {
            return RequestValidationException("No se puede dar de baja via edicion; usar la operacion de baja")
        }
        val from = current.uppercase().takeIf { it in VALID_STATUSES } ?: "DRAFT"
        val allowed = LEGAL_TRANSITIONS[from] ?: emptySet()
        if (requested !in allowed) {
            return RequestValidationException("Transicion de estado ilegal: $from -> $requested")
        }
        return null
    }

    private fun extractId(function: String): String? {
        val parts = function.split("/")
        return if (parts.size >= 3) parts[2] else null
    }

    private companion object {
        val VALID_STATUSES = setOf("DRAFT", "PUBLISHED", "PAUSED", "INACTIVE")
        val CREATABLE_STATUSES = setOf("DRAFT", "PUBLISHED")

        // Transiciones legales via edicion/pausa/reanudacion (PUT). INACTIVE se excluye:
        // solo se alcanza por la operacion de baja (DELETE -> discontinueProduct).
        val LEGAL_TRANSITIONS: Map<String, Set<String>> = mapOf(
            "DRAFT" to setOf("DRAFT", "PUBLISHED"),
            "PUBLISHED" to setOf("PUBLISHED", "PAUSED", "DRAFT"),
            "PAUSED" to setOf("PAUSED", "PUBLISHED"),
            // INACTIVE es terminal para PUT: un producto dado de baja no se reactiva por edicion.
            "INACTIVE" to emptySet()
        )
    }
}
