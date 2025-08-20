package ar.com.intrale

import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

object UserBusinessProfileUtils {
    fun hasAnyApprovedProfile(table: DynamoDbTable<UserBusinessProfile>, email: String): Boolean {
        return table.scan().items().any { it.email == email && it.state == BusinessState.APPROVED }
    }

    fun computeRelationState(table: DynamoDbTable<UserBusinessProfile>, email: String): BusinessState {
        return if (hasAnyApprovedProfile(table, email)) BusinessState.APPROVED else BusinessState.PENDING
    }

    fun upsertUserBusinessProfile(
        table: DynamoDbTable<UserBusinessProfile>,
        email: String,
        business: String,
        profile: String,
        state: BusinessState
    ) {
        val relation = UserBusinessProfile().apply {
            this.email = email
            this.business = business
            this.profile = profile
            this.state = state
        }
        table.putItem(relation)
    }
}

