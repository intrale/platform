package ar.com.intrale

import com.google.gson.Gson
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

class SearchBusinesses(
    private val tableBusiness: DynamoDbTable<Business>,
    private val logger: Logger
) : Function {

    override suspend fun execute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("starting search businesses $function")
        if (textBody.isEmpty()) return RequestValidationException("Request body not found")
        val body = Gson().fromJson(textBody, SearchBusinessesRequest::class.java)

        val items = tableBusiness.scan().items().toList()

        val filtered = items
            .filter { body.query.isBlank() || it.name?.contains(body.query, ignoreCase = true) == true }
            .filter { body.status == null || it.state.name.equals(body.status, ignoreCase = true) }
            .sortedBy { it.name ?: "" }

        val startIndex = body.lastKey?.let { key -> filtered.indexOfFirst { it.name == key } + 1 } ?: 0
        val limit = body.limit

        val paged = if (limit != null) {
            filtered.drop(startIndex).take(limit)
        } else {
            filtered.drop(startIndex)
        }

        val lastKey = if (limit != null && startIndex + limit < filtered.size) {
            filtered[startIndex + limit - 1].name
        } else {
            null
        }

        val responseItems = paged.map {
            BusinessDTO(
                businessId = it.businessId ?: "",
                publicId = it.publicId ?: "",
                name = it.name ?: "",
                description = it.description ?: "",
                emailAdmin = it.emailAdmin ?: "",
                autoAcceptDeliveries = it.autoAcceptDeliveries,
                status = it.state.name
            )
        }

        logger.debug("return search businesses $function")
        return SearchBusinessesResponse(responseItems.toTypedArray(), lastKey)
    }
}
