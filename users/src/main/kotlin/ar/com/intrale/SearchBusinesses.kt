package ar.com.intrale

import com.google.gson.Gson
import org.slf4j.Logger

class SearchBusinesses(
    val config: UsersConfig,
    val logger: Logger
) : Function {

    override suspend fun execute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("starting search businesses $function")
        val body = if (textBody.isNotEmpty()) {
            Gson().fromJson(textBody, SearchBusinessesRequest::class.java)
        } else {
            SearchBusinessesRequest()
        }
        val businesses = config.businesses
        val filtered = businesses
            .filter { body.query.isBlank() || it.contains(body.query, ignoreCase = true) }
            .map {
                BusinessDTO(
                    id = it,
                    name = it,
                    description = "",
                    emailAdmin = "${it}@admin.com",
                    autoAcceptDeliveries = false,
                    status = "PENDING"
                )
            }
            .filter { body.status == null || it.status.equals(body.status, ignoreCase = true) }
        val limited = if (body.limit != null) filtered.take(body.limit) else filtered
        logger.debug("return search businesses $function")
        return SearchBusinessesResponse(limited.toTypedArray(), null)
    }
}
