package ar.com.intrale

import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey

@DynamoDbBean
class Business(
    var businessId: String? = null,
    var publicId: String? = null,
    @get:DynamoDbPartitionKey
    var name: String? = null,
    var emailAdmin: String? = null,
    var description: String? = null,
    var state: BusinessState = BusinessState.PENDING,
    var autoAcceptDeliveries: Boolean = false,
    var autoResponseEnabled: Boolean = false,
    var fonts: MutableMap<String, String> = mutableMapOf(),
    var address: String? = null,
    var phone: String? = null,
    var logoUrl: String? = null,
    var schedulesJson: String? = null,
    var deliveryZoneJson: String? = null,
    var paymentMethodsJson: String? = null,
    var weeklyReportEnabled: Boolean = false,
    var weeklyReportContactType: String? = null,
    var weeklyReportContactId: String? = null
)
