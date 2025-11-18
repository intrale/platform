package ar.com.intrale

import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey

@DynamoDbBean
class BusinessLookAndFeel {
    @get:DynamoDbPartitionKey
    var businessId: String? = null

    var colors: MutableMap<String, String>? = mutableMapOf()

    var lastUpdated: String? = null

    var updatedBy: String? = null
}
