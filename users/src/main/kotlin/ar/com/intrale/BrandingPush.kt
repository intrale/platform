package ar.com.intrale

import io.ktor.http.HttpStatusCode

class BrandingPush : Function {
    override suspend fun execute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        return BrandingPushResponse(
            statusCode = HttpStatusCode.Accepted,
            businessId = business,
            deviceId = headers["X-Device-Id"] ?: "unknown",
            message = "Registro de push en preparación"
        )
    }
}

data class BrandingPushResponse(
    val statusCode: HttpStatusCode,
    val businessId: String,
    val deviceId: String,
    val message: String
) : Response(statusCode)
