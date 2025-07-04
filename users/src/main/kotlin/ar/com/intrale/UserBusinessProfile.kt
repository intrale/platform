package ar.com.intrale

import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey

@DynamoDbBean
class UserBusinessProfile {
    @get:DynamoDbPartitionKey
    var compositeKey: String = ""

    var email: String = ""
        set(value) {
            field = value
            updateCompositeKey()
        }

    var business: String = ""
        set(value) {
            field = value
            updateCompositeKey()
        }

    var profile: String = ""
        set(value) {
            field = value
            updateCompositeKey()
        }

    var state: BusinessState = BusinessState.PENDING

    private fun updateCompositeKey() {
        compositeKey = "$email#$business#$profile"
    }
}
