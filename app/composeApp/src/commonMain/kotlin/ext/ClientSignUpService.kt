package ext

import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.utils.io.InternalAPI
import kotlinx.serialization.Serializable

class ClientSignUpService(private val httpClient: HttpClient) : CommSignUpService {
    @OptIn(InternalAPI::class)
    override suspend fun execute(function: String, email: String) {
        httpClient.post("https://66d32be4184dce1713cf7f64.mockapi.io/intrale/v1/$function") {
            setBody(SignUpRequest(email))
        }
    }
}

@Serializable
data class SignUpRequest(val email: String)
