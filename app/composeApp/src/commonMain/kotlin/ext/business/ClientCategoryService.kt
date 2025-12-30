package ext.business

import ar.com.intrale.BuildKonfig
import ext.auth.ExceptionResponse
import ext.auth.toExceptionResponse
import ext.dto.StatusCodeDTO
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class ClientCategoryService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommCategoryService {

    private val logger = LoggerFactory.default.newLogger<ClientCategoryService>()

    override suspend fun listCategories(businessId: String): Result<List<CategoryDTO>> =
        runCatching {
            logger.info { "Listando categorías para negocio $businessId" }
            val response = httpClient.get(categoriesUrl(businessId)) {
                authorize()
            }
            response.toCategories()
        }

    override suspend fun createCategory(
        businessId: String,
        request: CategoryRequest
    ): Result<CategoryDTO> =
        runCatching {
            logger.info { "Creando categoría ${request.name}" }
            val response = httpClient.post(categoriesUrl(businessId)) {
                authorize()
                setBody(request)
            }
            response.toCategory()
        }

    override suspend fun updateCategory(
        businessId: String,
        categoryId: String,
        request: CategoryRequest
    ): Result<CategoryDTO> =
        runCatching {
            logger.info { "Actualizando categoría $categoryId" }
            val response = httpClient.put(categoryUrl(businessId, categoryId)) {
                authorize()
                setBody(request)
            }
            response.toCategory()
        }

    override suspend fun deleteCategory(
        businessId: String,
        categoryId: String,
        reassignToCategoryId: String?
    ): Result<Unit> =
        runCatching {
            logger.info { "Eliminando categoría $categoryId" }
            val response = httpClient.delete(categoryUrl(businessId, categoryId)) {
                authorize()
                reassignToCategoryId?.let { parameter("reassignToCategoryId", it) }
            }
            if (!response.status.isSuccess()) {
                throw response.bodyAsText().toCategoryException()
            }
            Unit
        }

    private fun categoriesUrl(businessId: String): String =
        "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/$businessId/categories"

    private fun categoryUrl(businessId: String, categoryId: String): String =
        "${categoriesUrl(businessId)}/$categoryId"

    private suspend fun HttpResponse.toCategory(): CategoryDTO {
        val bodyText = bodyAsText()
        if (status.isSuccess()) {
            runCatching { return Json.decodeFromString(CategoryDTO.serializer(), bodyText) }
            runCatching {
                val responseWrapper =
                    Json.decodeFromString(CategoryListResponse.serializer(), bodyText)
                responseWrapper.categories.firstOrNull()?.let { return it }
            }
            throw ExceptionResponse(
                statusCode = StatusCodeDTO(status.value, status.description),
                message = "Respuesta vacía del servidor"
            )
        }
        throw bodyText.toCategoryException()
    }

    private suspend fun HttpResponse.toCategories(): List<CategoryDTO> {
        val bodyText = bodyAsText()
        if (status.isSuccess()) {
            runCatching {
                return Json.decodeFromString(CategoryListResponse.serializer(), bodyText)
                    .categories
            }
            runCatching {
                return Json.decodeFromString(
                    ListSerializer(CategoryDTO.serializer()),
                    bodyText
                )
            }
            return emptyList()
        }
        throw bodyText.toCategoryException()
    }

    private fun String.toCategoryException(): ExceptionResponse =
        runCatching { Json.decodeFromString(ExceptionResponse.serializer(), this) }
            .getOrElse {
                logger.error(it) { "No se pudo parsear la respuesta de error" }
                ExceptionResponse(
                    statusCode = StatusCodeDTO(500, "Internal Server Error"),
                    message = this
                )
            }

    private fun io.ktor.client.request.HttpRequestBuilder.authorize() {
        val token = keyValueStorage.token
            ?: throw ExceptionResponse(
                statusCode = StatusCodeDTO(401, "Unauthorized"),
                message = "Token no disponible"
            )
        header(HttpHeaders.Authorization, "Bearer $token")
    }
}
