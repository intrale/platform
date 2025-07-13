package ext

import ar.com.intrale.BuildKonfig
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.utils.io.InternalAPI
import kotlinx.serialization.Serializable
import ext.AppConfig

class ClientSignUpService(private val httpClient: HttpClient) : CommSignUpService {
    @OptIn(InternalAPI::class)
    override suspend fun execute(email: String) {

        httpClient.post("${BuildKonfig.BASE_URL}${BuildKonfig.BUSINESS}/signup") {
            setBody(SignUpRequest(email))
        }
    }
}

@Serializable
data class SignUpRequest(val email: String)
