package ar.com.intrale

import ar.com.intrale.shared.client.ProductAvailabilityItemDTO
import ar.com.intrale.shared.client.ProductAvailabilityRequestDTO
import ar.com.intrale.shared.client.ProductAvailabilityResponseDTO
import ar.com.intrale.shared.client.SkipReason
import com.auth0.jwt.JWT
import com.google.gson.Gson
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

/**
 * Endpoint de consulta de disponibilidad de productos (batch).
 * POST /{business}/client/products/availability
 *
 * Recibe una lista de IDs de productos y retorna el estado de disponibilidad
 * de cada uno, con motivo de exclusión cuando corresponde.
 *
 * Requisitos de seguridad:
 * - SecuredFunction (JWT obligatorio)
 * - Solo consulta productos del negocio del path (sin leak cross-business)
 * - No expone stockQuantity ni IDs internos de DynamoDB
 */
class ClientProductsAvailability(
    override val config: UsersConfig,
    override val logger: Logger,
    private val productRepository: ProductRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    companion object {
        const val MAX_PRODUCT_IDS = 50
    }

    private val gson = Gson()

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Post.value.uppercase()

        if (method != HttpMethod.Post.value.uppercase()) {
            return RequestValidationException("Metodo no soportado: $method")
        }

        val email = resolveEmail(headers)
        logger.info("Consultando disponibilidad de productos para negocio=$business usuario=${email ?: "desconocido"}")

        val request = runCatching {
            gson.fromJson(textBody, ProductAvailabilityRequestDTO::class.java)
        }.getOrElse {
            return RequestValidationException("Request body invalido: ${it.message}")
        }

        // Validación: lista no vacía
        if (request.productIds.isEmpty()) {
            return RequestValidationException("La lista de productIds no puede estar vacia")
        }

        // Validación: máximo de IDs
        if (request.productIds.size > MAX_PRODUCT_IDS) {
            return RequestValidationException("Maximo $MAX_PRODUCT_IDS productos por consulta, recibidos: ${request.productIds.size}")
        }

        // Validación: IDs no vacíos y sin caracteres especiales
        val invalidIds = request.productIds.filter { id ->
            id.isBlank() || !id.matches(Regex("^[a-zA-Z0-9\\-_]+$"))
        }
        if (invalidIds.isNotEmpty()) {
            return RequestValidationException("IDs de producto invalidos: formato incorrecto")
        }

        // Validación: sin duplicados
        val uniqueIds = request.productIds.distinct()

        // Buscar productos del negocio (filtrado por business automáticamente)
        val foundProducts = productRepository.getProductsByIds(business, uniqueIds)
        val foundMap = foundProducts.associateBy { it.id }

        logger.info("Disponibilidad consultada: ${uniqueIds.size} IDs, ${foundProducts.size} encontrados en negocio=$business")

        val items = uniqueIds.map { productId ->
            val record = foundMap[productId]
            when {
                // Producto no encontrado en este negocio → UNKNOWN_PRODUCT
                record == null -> ProductAvailabilityItemDTO(
                    productId = productId,
                    name = "",
                    available = false,
                    reason = SkipReason.UNKNOWN_PRODUCT
                )
                // Producto no publicado (Draft u otro estado) → DISCONTINUED
                record.status.uppercase() != "PUBLISHED" -> ProductAvailabilityItemDTO(
                    productId = productId,
                    name = record.name,
                    available = false,
                    reason = SkipReason.DISCONTINUED
                )
                // Producto marcado como no disponible → UNAVAILABLE
                !record.isAvailable -> ProductAvailabilityItemDTO(
                    productId = productId,
                    name = record.name,
                    available = false,
                    reason = SkipReason.UNAVAILABLE
                )
                // Producto con stock agotado → OUT_OF_STOCK
                record.stockQuantity != null && record.stockQuantity <= 0 -> ProductAvailabilityItemDTO(
                    productId = productId,
                    name = record.name,
                    available = false,
                    reason = SkipReason.OUT_OF_STOCK
                )
                // Producto disponible
                else -> ProductAvailabilityItemDTO(
                    productId = productId,
                    name = record.name,
                    available = true,
                    reason = null
                )
            }
        }

        return ProductAvailabilityResponse(
            availability = ProductAvailabilityResponseDTO(items = items),
            status = HttpStatusCode.OK
        )
    }

    private fun resolveEmail(headers: Map<String, String>): String? {
        val token = headers["Authorization"] ?: headers["authorization"]
        val decoded = token
            ?.removePrefix("Bearer ")
            ?.takeIf { it.isNotBlank() }
            ?.let { runCatching { JWT.decode(it) }.getOrNull() }

        return decoded?.getClaim("email")?.asString()
            ?: decoded?.subject
            ?: headers["X-Debug-User"]
    }
}
