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

class ClientProductService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommProductService {

    private val logger = LoggerFactory.default.newLogger<ClientProductService>()

    override suspend fun listProducts(businessId: String): Result<List<ProductDTO>> =
        runCatching {
            logger.info { "Listando productos para negocio $businessId" }
            val response = httpClient.get(productsUrl(businessId)) {
                authorize()
            }
            response.toProducts()
        }

    override suspend fun getProduct(businessId: String, productId: String): Result<ProductDTO> =
        runCatching {
            logger.info { "Obteniendo producto $productId" }
            val response = httpClient.get(productUrl(businessId, productId)) {
                authorize()
            }
            response.toProduct()
        }

    override suspend fun createProduct(
        businessId: String,
        request: ProductRequest
    ): Result<ProductDTO> =
        runCatching {
            logger.info { "Creando producto ${request.name}" }
            val response = httpClient.post(productsUrl(businessId)) {
                authorize()
                setBody(request)
            }
            response.toProduct()
        }

    override suspend fun updateProduct(
        businessId: String,
        productId: String,
        request: ProductRequest
    ): Result<ProductDTO> =
        runCatching {
            logger.info { "Actualizando producto $productId" }
            val response = httpClient.put(productUrl(businessId, productId)) {
                authorize()
                setBody(request)
            }
            response.toProduct()
        }

    override suspend fun deleteProduct(businessId: String, productId: String): Result<Unit> =
        runCatching {
            logger.info { "Eliminando producto $productId" }
            val response = httpClient.delete(productUrl(businessId, productId)) {
                authorize()
            }
            if (!response.status.isSuccess()) {
                throw response.bodyAsText().toProductException()
            }
            Unit
        }

    private fun productsUrl(businessId: String): String =
        "${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/business/$businessId/products"

    private fun productUrl(businessId: String, productId: String): String =
        "${productsUrl(businessId)}/$productId"

    private suspend fun HttpResponse.toProduct(): ProductDTO {
        val bodyText = bodyAsText()
        if (status.isSuccess()) {
            runCatching { return Json.decodeFromString(ProductDTO.serializer(), bodyText) }
            runCatching {
                val responseWrapper =
                    Json.decodeFromString(ProductListResponse.serializer(), bodyText)
                responseWrapper.products.firstOrNull()?.let { return it }
            }
            throw ExceptionResponse(
                statusCode = StatusCodeDTO(status.value, status.description),
                message = "Respuesta vacía del servidor"
            )
        }
        throw bodyText.toProductException()
    }

    private suspend fun HttpResponse.toProducts(): List<ProductDTO> {
        val bodyText = bodyAsText()
        if (status.isSuccess()) {
            runCatching { return Json.decodeFromString(ProductListResponse.serializer(), bodyText).products }
            runCatching { return Json.decodeFromString(ListSerializer(ProductDTO.serializer()), bodyText) }
            return emptyList()
        }
        throw bodyText.toProductException()
    }

    private fun String.toProductException(): ExceptionResponse =
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
