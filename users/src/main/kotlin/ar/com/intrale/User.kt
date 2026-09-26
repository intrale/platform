// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ar.com.intrale

import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey

@DynamoDbBean
class User(
    @get:DynamoDbPartitionKey
    var email: String? = null,
    var name: String? = null,
    var familyName: String? = null,
    var secret: String? = null  ,
    var enabled: Boolean = false
)
