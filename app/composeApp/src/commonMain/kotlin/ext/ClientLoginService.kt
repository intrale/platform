package ext

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.headers
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.utils.io.InternalAPI
import kotlinx.serialization.Serializable
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class ClientLoginService(val httpClient: HttpClient) : CommLoginService {

    private val logger = LoggerFactory.default.newLogger<ClientLoginService>()

    @OptIn(InternalAPI::class)
    override suspend fun execute(user: String, password: String): LoginResponse {
        val response: LoginResponse =
            httpClient.post("https://66d32be4184dce1713cf7f64.mockapi.io/intrale/v1/login"){
                headers {

                }
                setBody(LoginRequest(user, password))
            }.body()

        logger.debug {
            "response body:"  + response
        }

        return response
    }
}

@Serializable
data class LoginRequest(val user:String, val password: String)

@Serializable
data class LoginResponse(val token:String)