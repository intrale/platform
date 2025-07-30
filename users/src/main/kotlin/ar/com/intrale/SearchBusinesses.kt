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
        val filtered = if (body.query.isBlank()) {
            businesses
        } else {
            businesses.filter { it.contains(body.query, ignoreCase = true) }
        }
        val names = filtered.toTypedArray()
        logger.debug("return search businesses $function")
        return SearchBusinessesResponse(names)
    }
}
