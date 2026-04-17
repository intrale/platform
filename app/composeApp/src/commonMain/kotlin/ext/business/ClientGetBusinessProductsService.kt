package ext.business

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.ExceptionResponse
import ar.com.intrale.shared.toExceptionResponse
import ar.com.intrale.shared.business.BusinessProductsResponse
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import ext.IntraleClientJson
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class ClientGetBusinessProductsService(
    private val httpClient: HttpClient
) : CommGetBusinessProductsService {

    private val logger = LoggerFactory.default.newLogger<ClientGetBusinessProductsService>()

    override suspend fun execute(
        businessId: String,
        status: String
    ): Result<BusinessProductsResponse> {
        return try {
            val response = httpClient.get("${BuildKonfig.BASE_URL}$businessId/products") {
                parameter("status", status)
            }
            val bodyText = response.bodyAsText()
            if (response.status.isSuccess()) {
                val result = IntraleClientJson.decodeFromString(BusinessProductsResponse.serializer(), bodyText)
                logger.debug { "Productos cargados: ${result.products.size}" }
                Result.success(result)
            } else {
                val exception = IntraleClientJson.decodeFromString(ExceptionResponse.serializer(), bodyText)
                Result.failure(exception)
            }
        } catch (e: Exception) {
            Result.failure(e.toExceptionResponse())
        }
    }
}
