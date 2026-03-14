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

        val authorized = requireApprovedProfile(cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN)
            ?: requireApprovedProfile(cognito, headers, tableProfiles, business, PROFILE_SALER)
            ?: return UnauthorizedException()

        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()
        val productId = extractId(function)

        return when (method) {
            HttpMethod.Get.value.uppercase() -> handleGet(business, productId)
            HttpMethod.Post.value.uppercase() -> handlePost(business, textBody)
            HttpMethod.Put.value.uppercase() -> handlePut(business, productId, textBody)
            HttpMethod.Delete.value.uppercase() -> handleDelete(business, productId)
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

        val record = ProductRecord(
            name = body.name,
            shortDescription = body.shortDescription,
            basePrice = body.basePrice,
            unit = body.unit,
            categoryId = body.categoryId,
            status = normalizeStatus(body.status),
            isAvailable = body.isAvailable,
            stockQuantity = body.stockQuantity
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

        val record = ProductRecord(
            name = body.name,
            shortDescription = body.shortDescription,
            basePrice = body.basePrice,
            unit = body.unit,
            categoryId = body.categoryId,
            status = normalizeStatus(body.status),
            isAvailable = body.isAvailable,
            stockQuantity = body.stockQuantity
        )
        val updated = productRepository.updateProduct(business, productId, record)
            ?: return ExceptionResponse("Producto no encontrado", status = HttpStatusCode.NotFound)
        logger.debug("Producto actualizado id=$productId en negocio=$business")
        return ProductResponse(product = updated.toPayload(), status = HttpStatusCode.OK)
    }

    private fun handleDelete(business: String, productId: String?): Response {
        if (productId == null) return RequestValidationException("ID de producto requerido")

        val deleted = productRepository.deleteProduct(business, productId)
        if (!deleted) return ExceptionResponse("Producto no encontrado", status = HttpStatusCode.NotFound)
        logger.debug("Producto eliminado id=$productId en negocio=$business")
        return NoContentResponse()
    }

    private fun validateProductRequest(body: ProductRequest): Response? {
        if (body.name.isBlank()) return RequestValidationException("El nombre es requerido")
        if (body.basePrice <= 0) return RequestValidationException("El precio base debe ser mayor a cero")
        return null
    }

    private fun normalizeStatus(status: String?): String {
        return when (status?.uppercase()) {
            "PUBLISHED" -> "PUBLISHED"
            else -> "DRAFT"
        }
    }

    private fun extractId(function: String): String? {
        val parts = function.split("/")
        return if (parts.size >= 3) parts[2] else null
    }
}
