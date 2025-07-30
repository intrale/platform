package ar.com.intrale

import com.google.gson.Gson
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import ar.com.intrale.BusinessState
import kotlin.collections.plus


class SearchBusinesses(
    val config: UsersConfig,
    val logger: Logger,
    private val tableBusiness: DynamoDbTable<Business>
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
        val items = tableBusiness.scan().items().filter { it.state == BusinessState.APPROVED }
        val filtered = if (body.query.isBlank()) items else items.filter { it.name?.contains(body.query, ignoreCase = true) == true }
        var names = filtered.mapNotNull { it.name }.toTypedArray()
        logger.debug("return search businesses $function")
        return SearchBusinessesResponse(names)
    }
}
