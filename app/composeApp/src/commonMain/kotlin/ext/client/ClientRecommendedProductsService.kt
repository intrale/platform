package ext.client

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.StatusCodeDTO
import ar.com.intrale.shared.client.RecommendedProductsResponse
import ext.storage.CommKeyValueStorage
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class ClientRecommendedProductsService(
    private val httpClient: HttpClient,
    private val keyValueStorage: CommKeyValueStorage
) : CommRecommendedProductsService {

    private val logger = LoggerFactory.default.newLogger<ClientRecommendedProductsService>()

    override suspend fun execute(businessId: String): Result<RecommendedProductsResponse> {
        return try {
            logger.info { "Obteniendo productos recomendados para negocio $businessId" }
            val response = httpClient.get("${BuildKonfig.BASE_URL}$businessId/client/recommendations") {
                authorize()
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val result = Json.decodeFromString(RecommendedProductsResponse.serializer(), bodyText)
                logger.debug { "Productos recomendados: ${result.products.size}" }
                Result.success(result)
            } else {
                logger.warning { "Error al obtener recomendaciones: ${response.status}" }
                Result.success(RecommendedProductsResponse(
                    statusCode = StatusCodeDTO(response.status.value, response.status.description),
                    products = emptyList()
                ))
            }
        } catch (e: Exception) {
            logger.warning(e) { "Fallo al obtener recomendaciones, devolviendo lista vacía" }
            Result.success(RecommendedProductsResponse(products = emptyList()))
        }
    }

    private fun io.ktor.client.request.HttpRequestBuilder.authorize() {
        val token = keyValueStorage.token
            ?: throw ClientExceptionResponse(
                message = "Token no disponible",
                statusCode = StatusCodeDTO(401, "Unauthorized")
            )
        header(HttpHeaders.Authorization, "Bearer $token")
    }
}
