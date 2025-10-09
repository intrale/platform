package ar.com.intrale

import io.ktor.http.HttpStatusCode

class BrandingStatus : Function {
    override suspend fun execute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        return BrandingStatusResponse(
            statusCode = HttpStatusCode.OK,
            version = "v0",
            lastUpdated = "1970-01-01T00:00:00Z"
        )
    }
}

data class BrandingStatusResponse(
    val statusCode: HttpStatusCode,
    val version: String,
    val lastUpdated: String
) : Response(statusCode)
