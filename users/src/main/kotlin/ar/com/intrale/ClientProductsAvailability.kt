package ar.com.intrale

import com.google.gson.Gson
import com.google.gson.JsonSyntaxException
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

/**
 * Endpoint POST /client/products/availability
 *
 * Consulta la disponibilidad de productos por IDs en batch.
 * Retorna para cada producto si esta disponible y, si no, el motivo.
 */
class ClientProductsAvailability(
    override val config: UsersConfig,
    override val logger: Logger,
    private val productRepository: ProductRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    companion object {
        const val MAX_PRODUCT_IDS = 50
        private val VALID_ID_REGEX = Regex("^[a-zA-Z0-9\\-_]+$")
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
            return RequestValidationException("Metodo no soportado: $method. Solo se acepta POST.")
        }

        // Parsear request
        val request = try {
            gson.fromJson(textBody, AvailabilityRequest::class.java)
                ?: return RequestValidationException("Request body vacio o invalido")
        } catch (e: JsonSyntaxException) {
            return RequestValidationException("Request body no es JSON valido: ${e.message}")
        }

        // Validar lista de IDs
        if (request.productIds.isNullOrEmpty()) {
            return RequestValidationException("La lista de productIds no puede estar vacia")
        }

        if (request.productIds.size > MAX_PRODUCT_IDS) {
            return RequestValidationException(
                "La lista de productIds no puede superar $MAX_PRODUCT_IDS elementos (recibidos: ${request.productIds.size})"
            )
        }

        val distinctIds = request.productIds.distinct()
        if (distinctIds.size != request.productIds.size) {
            return RequestValidationException("La lista de productIds contiene duplicados")
        }

        val invalidIds = request.productIds.filter { it.isBlank() || !VALID_ID_REGEX.matches(it) }
        if (invalidIds.isNotEmpty()) {
            return RequestValidationException(
                "IDs con formato invalido: ${invalidIds.joinToString(", ")}"
            )
        }

        logger.info("Consultando disponibilidad de ${request.productIds.size} productos para negocio=$business")

        // Consultar disponibilidad
        val items = request.productIds.map { productId ->
            val product = productRepository.getProduct(business, productId)
            when {
                product == null -> AvailabilityItemPayload(
                    productId = productId,
                    available = false,
                    reason = "UNKNOWN_PRODUCT"
                )
                product.status.uppercase() != "PUBLISHED" -> AvailabilityItemPayload(
                    productId = productId,
                    available = false,
                    reason = "DISCONTINUED"
                )
                !product.isAvailable -> AvailabilityItemPayload(
                    productId = productId,
                    available = false,
                    reason = "UNAVAILABLE"
                )
                product.stockQuantity != null && product.stockQuantity <= 0 -> AvailabilityItemPayload(
                    productId = productId,
                    available = false,
                    reason = "OUT_OF_STOCK"
                )
                else -> AvailabilityItemPayload(
                    productId = productId,
                    available = true,
                    reason = null
                )
            }
        }

        logger.info(
            "Disponibilidad consultada: ${items.count { it.available }} disponibles, " +
            "${items.count { !it.available }} no disponibles para negocio=$business"
        )

        return ProductAvailabilityResponse(
            items = items,
            status = HttpStatusCode.OK
        )
    }
}

/** Request interno para Gson */
internal data class AvailabilityRequest(
    val productIds: List<String>? = null
)

/** Payload de cada item en la respuesta */
data class AvailabilityItemPayload(
    val productId: String,
    val available: Boolean,
    val reason: String? = null
)

/** Response del endpoint */
class ProductAvailabilityResponse(
    val items: List<AvailabilityItemPayload>,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)
