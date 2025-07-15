package ext

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.ClientRequestException
import io.ktor.client.request.headers
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import ar.com.intrale.BuildKonfig
import io.ktor.utils.io.InternalAPI
import kotlinx.serialization.Serializable
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class ClientLoginService(val httpClient: HttpClient) : CommLoginService {

    private val logger = LoggerFactory.default.newLogger<ClientLoginService>()

    @OptIn(InternalAPI::class)
    override suspend fun execute(user: String, password: String): Result<LoginResponse> {
        return try {
            val response: LoginResponse =
                httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/login") {
                    headers {

                    }
                    setBody(LoginRequest(user, password))
                }.body()

            logger.debug {
                "response body:"  + response
            }

            Result.success(response)
        } catch (e: ClientRequestException) {
            logger.error { "client error: ${'$'}{e.message}" }
            Result.failure(e)
        } catch (e: Exception) {
            logger.error { "login error: ${'$'}{e.message}" }
            Result.failure(e)
        }
    }
}

@Serializable
data class LoginRequest(val user:String, val password: String)

@Serializable
data class LoginResponse(val token:String)