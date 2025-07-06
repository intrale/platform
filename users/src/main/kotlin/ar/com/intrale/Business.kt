package ar.com.intrale

import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey

@DynamoDbBean
class Business(
    @get:DynamoDbPartitionKey
    var name: String? = null,
    var emailAdmin: String? = null,
    var description: String? = null,
    var state: BusinessState = BusinessState.PENDING,
    var autoAcceptDeliveries: Boolean = false
)
