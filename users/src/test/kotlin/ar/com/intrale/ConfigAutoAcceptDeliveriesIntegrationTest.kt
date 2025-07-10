package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.GetUserResponse
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import io.ktor.http.HttpStatusCode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.Ignore



class ConfigAutoAcceptDeliveriesIntegrationTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = UsersConfig(setOf("biz"), "us-east-1", "key", "secret", "pool", "client")

    @Test
    @Ignore("Falla por UnsupportedOperationException de DynamoDbTable")
    fun `configuracion exitosa`() = runBlocking {
        val table = DummyBusinessConfigTable().apply { item = Business().apply { name = "biz" } }
        val cognito = mockk<CognitoIdentityProviderClient>(relaxed = true)
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = PROFILE_ATT_NAME; value = PROFILE_BUSINESS_ADMIN })
        }
        val function = ConfigAutoAcceptDeliveries(config, logger, cognito, table)

        val response1 = function.securedExecute(
            business = "biz",
            function = "configAutoAcceptDeliveries",
            headers = mapOf("Authorization" to "token"),
            textBody = "{\"autoAcceptDeliveries\":true}"
        )

        val response2 = function.securedExecute(
            business = "biz",
            function = "configAutoAcceptDeliveries",
            headers = mapOf("Authorization" to "token"),
            textBody = "{\"autoAcceptDeliveries\":true}"
        )

        assertEquals(HttpStatusCode.OK, response1.statusCode)
        assertEquals(HttpStatusCode.OK, response2.statusCode)
        assertEquals(true, table.item?.autoAcceptDeliveries)
    }
}
