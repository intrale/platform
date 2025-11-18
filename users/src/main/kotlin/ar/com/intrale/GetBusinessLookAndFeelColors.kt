package ar.com.intrale

import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

class GetBusinessLookAndFeelColors(
    private val lookAndFeelTable: DynamoDbTable<BusinessLookAndFeel>,
    private val logger: Logger
) : Function {

    override suspend fun execute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("starting get business look and feel colors $function for $business")

        if (business.isBlank()) {
            return RequestValidationException("Business not defined on path")
        }

        val key = BusinessLookAndFeel().apply { businessId = business }
        val entity = lookAndFeelTable.getItem(key)

        logger.debug("returning get business look and feel colors $function for $business")
        return BusinessLookAndFeelColorsResponse(
            colors = entity?.colors ?: emptyMap(),
            lastUpdated = entity?.lastUpdated,
            updatedBy = entity?.updatedBy
        )
    }
}
