package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

/**
 * Request para conteo de stock por foto.
 * La imagen se envia codificada en base64.
 */
data class StockCountRequest(
    val imageBase64: String = "",
    val mediaType: String = "image/jpeg",
    val autoUpdate: Boolean = false
)

/**
 * Respuesta del conteo de stock por foto.
 */
class StockCountResponse(
    @Suppress("unused")
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val products: List<StockCountProductDTO> = emptyList(),
    val unrecognizedCount: Int = 0,
    val processingTimeMs: Long = 0,
    val notes: String? = null,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * DTO de producto identificado en la respuesta.
 */
data class StockCountProductDTO(
    val name: String,
    val quantity: Int,
    val confidence: Double,
    val matchedProductId: String? = null,
    val updated: Boolean = false
)

/**
 * Endpoint segurizado para conteo de stock por foto.
 * Solo accesible por duenos de negocio (perfil BUSINESS).
 *
 * Ruta: POST /{business}/business/stock-count
 *
 * Flujo:
 * 1. Recibe imagen base64 del cliente
 * 2. Obtiene lista de productos conocidos del negocio
 * 3. Invoca Claude Vision para identificar y contar
 * 4. Opcionalmente actualiza el stock si autoUpdate=true
 * 5. Retorna productos identificados con cantidades
 */
class StockCountFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val tableBusiness: DynamoDbTable<Business>,
    private val productRepository: ProductRepository,
    private val visionService: VisionStockCountService,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    private val gson = Gson()

    // Maximo 10MB de imagen en base64
    private val maxImageSizeBytes = 10 * 1024 * 1024

    // Tipos de imagen soportados
    private val supportedMediaTypes = setOf(
        "image/jpeg", "image/png", "image/gif", "image/webp"
    )

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        val method = headers["X-Http-Method"] ?: "POST"
        if (method != "POST") {
            return ExceptionResponse("Metodo no soportado: $method", HttpStatusCode.MethodNotAllowed)
        }

        logger.debug("Iniciando conteo de stock por foto para negocio=$business")

        // Verificar que el negocio existe
        val key = Business().apply { name = business }
        val businessEntity = tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        // Parsear request
        val request = parseBody<StockCountRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        // Validar imagen
        val validationError = validateRequest(request)
        if (validationError != null) return validationError

        // Obtener productos conocidos del negocio
        val knownProducts = productRepository.listPublishedProducts(business).map { p ->
            ProductSummary(
                name = p.name,
                shortDescription = p.shortDescription,
                basePrice = p.basePrice,
                unit = p.unit,
                category = p.categoryId,
                isAvailable = p.isAvailable
            )
        }

        // Invocar servicio de vision
        return try {
            val result = visionService.countStock(
                imageBase64 = request.imageBase64,
                mediaType = request.mediaType,
                knownProducts = knownProducts
            )

            // Si autoUpdate, actualizar stock de los productos matcheados
            val updatedProducts = if (request.autoUpdate) {
                updateStock(business, result.products)
            } else {
                result.products.map { p ->
                    StockCountProductDTO(
                        name = p.name,
                        quantity = p.quantity,
                        confidence = p.confidence,
                        matchedProductId = p.matchedProductId,
                        updated = false
                    )
                }
            }

            logger.info("Conteo de stock completado para negocio=$business: ${result.products.size} productos identificados en ${result.processingTimeMs}ms")

            StockCountResponse(
                products = updatedProducts,
                unrecognizedCount = result.unrecognizedCount,
                processingTimeMs = result.processingTimeMs,
                notes = result.notes
            )
        } catch (e: Exception) {
            logger.error("Error en conteo de stock por foto para negocio=$business", e)
            ExceptionResponse(
                "Error procesando la imagen: ${e.message}",
                HttpStatusCode.InternalServerError
            )
        }
    }

    private fun validateRequest(request: StockCountRequest): Response? {
        if (request.imageBase64.isBlank()) {
            return RequestValidationException("La imagen no puede estar vacia")
        }

        if (request.imageBase64.length > maxImageSizeBytes) {
            return RequestValidationException("La imagen supera el tamanio maximo permitido (10MB)")
        }

        if (request.mediaType !in supportedMediaTypes) {
            return RequestValidationException(
                "Tipo de imagen no soportado: ${request.mediaType}. " +
                    "Tipos validos: ${supportedMediaTypes.joinToString(", ")}"
            )
        }

        // Validar que el base64 es valido (verificacion basica)
        try {
            java.util.Base64.getDecoder().decode(
                request.imageBase64.take(100).toByteArray()
            )
        } catch (e: IllegalArgumentException) {
            return RequestValidationException("La imagen no tiene codificacion base64 valida")
        }

        return null
    }

    /**
     * Actualiza el stock de los productos matcheados y retorna los DTOs con flag updated.
     */
    private fun updateStock(
        business: String,
        identifiedProducts: List<IdentifiedProduct>
    ): List<StockCountProductDTO> {
        return identifiedProducts.map { identified ->
            var updated = false

            if (identified.matchedProductId != null) {
                // Buscar el producto por nombre para obtener su ID real
                val allProducts = productRepository.listPublishedProducts(business)
                val index = identified.matchedProductId.toIntOrNull()
                if (index != null && index < allProducts.size) {
                    val product = allProducts[index]
                    val updatedRecord = product.copy(stockQuantity = identified.quantity)
                    productRepository.updateProduct(business, product.id, updatedRecord)
                    updated = true
                    logger.info("Stock actualizado: ${product.name} -> ${identified.quantity} (negocio=$business)")
                }
            }

            StockCountProductDTO(
                name = identified.name,
                quantity = identified.quantity,
                confidence = identified.confidence,
                matchedProductId = identified.matchedProductId,
                updated = updated
            )
        }
    }
}
