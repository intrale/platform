package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

class BusinessCategories(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    private val categoryRepository: CategoryRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando business/categories para negocio=$business, function=$function")

        val authorized = requireApprovedProfile(cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN)
            ?: requireApprovedProfile(cognito, headers, tableProfiles, business, PROFILE_SALER)
            ?: return UnauthorizedException()

        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()
        val categoryId = extractId(function)

        return when (method) {
            HttpMethod.Get.value.uppercase() -> handleGet(business, categoryId)
            HttpMethod.Post.value.uppercase() -> handlePost(business, textBody)
            HttpMethod.Put.value.uppercase() -> handlePut(business, categoryId, textBody)
            HttpMethod.Delete.value.uppercase() -> handleDelete(business, categoryId)
            else -> RequestValidationException("Metodo no soportado: $method")
        }
    }

    private fun handleGet(business: String, categoryId: String?): Response {
        if (categoryId != null) {
            val category = categoryRepository.getCategory(business, categoryId)
                ?: return ExceptionResponse("Categoria no encontrada", status = HttpStatusCode.NotFound)
            return CategoryResponse(category = category.toPayload(), status = HttpStatusCode.OK)
        }
        val categories = categoryRepository.listCategories(business)
        return CategoryListResponse(categories = categories.map { it.toPayload() })
    }

    private fun handlePost(business: String, textBody: String): Response {
        val body = parseBody<CategoryRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (body.name.isBlank()) return RequestValidationException("El nombre es requerido")

        val record = CategoryRecord(
            name = body.name,
            description = body.description
        )
        val saved = categoryRepository.saveCategory(business, record)
        logger.debug("Categoria creada id=${saved.id} en negocio=$business")
        return CategoryResponse(category = saved.toPayload(), status = HttpStatusCode.Created)
    }

    private fun handlePut(business: String, categoryId: String?, textBody: String): Response {
        if (categoryId == null) return RequestValidationException("ID de categoria requerido")

        val body = parseBody<CategoryRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (body.name.isBlank()) return RequestValidationException("El nombre es requerido")

        val record = CategoryRecord(
            name = body.name,
            description = body.description
        )
        val updated = categoryRepository.updateCategory(business, categoryId, record)
            ?: return ExceptionResponse("Categoria no encontrada", status = HttpStatusCode.NotFound)
        logger.debug("Categoria actualizada id=$categoryId en negocio=$business")
        return CategoryResponse(category = updated.toPayload(), status = HttpStatusCode.OK)
    }

    private fun handleDelete(business: String, categoryId: String?): Response {
        if (categoryId == null) return RequestValidationException("ID de categoria requerido")

        val deleted = categoryRepository.deleteCategory(business, categoryId)
        if (!deleted) return ExceptionResponse("Categoria no encontrada", status = HttpStatusCode.NotFound)
        logger.debug("Categoria eliminada id=$categoryId en negocio=$business")
        return NoContentResponse()
    }

    private fun extractId(function: String): String? {
        val parts = function.split("/")
        return if (parts.size >= 3) parts[2] else null
    }
}
