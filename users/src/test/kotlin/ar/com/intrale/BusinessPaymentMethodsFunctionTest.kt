package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.GetUserResponse
import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.core.pagination.sync.SdkIterable
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.enhanced.dynamodb.model.Page
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

private class StubBusinessTablePayment : DynamoDbTable<Business> {
    val items = mutableListOf<Business>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<Business> = TableSchema.fromBean(Business::class.java)
    override fun tableName() = "business"
    override fun keyFrom(item: Business): Key = Key.builder().partitionValue(item.name).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun putItem(item: Business) { items.add(item) }
    override fun getItem(item: Business): Business? = items.find { it.name == item.name }
    override fun updateItem(item: Business): Business {
        val idx = items.indexOfFirst { it.name == item.name }
        if (idx >= 0) items[idx] = item else items.add(item)
        return item
    }
    override fun scan(): PageIterable<Business> =
        PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })
}

private class StubProfileTablePayment : DynamoDbTable<UserBusinessProfile> {
    val items = mutableListOf<UserBusinessProfile>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<UserBusinessProfile> = TableSchema.fromBean(UserBusinessProfile::class.java)
    override fun tableName() = "profiles"
    override fun keyFrom(item: UserBusinessProfile): Key = Key.builder().partitionValue(item.compositeKey).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun putItem(item: UserBusinessProfile) { items.add(item) }
    override fun getItem(item: UserBusinessProfile): UserBusinessProfile? =
        items.firstOrNull { it.compositeKey == item.compositeKey }
    override fun scan(): PageIterable<UserBusinessProfile> =
        PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })
}

class BusinessPaymentMethodsFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val tableBusiness = StubBusinessTablePayment()
    private val tableProfiles = StubProfileTablePayment()

    private val function = BusinessPaymentMethodsFunction(
        config, logger, cognito, tableBusiness, tableProfiles
    )

    private fun seedBusinessAdmin() {
        tableProfiles.items.add(UserBusinessProfile().apply {
            email = "admin@biz.com"
            business = "biz"
            profile = PROFILE_BUSINESS_ADMIN
            state = BusinessState.APPROVED
        })
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "admin@biz.com" })
        }
    }

    @Test
    fun `GET devuelve medios de pago por defecto si no hay datos almacenados`() = runBlocking {
        tableBusiness.items.add(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/payment-methods",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is BusinessPaymentMethodsResponse)
        val paymentResponse = response as BusinessPaymentMethodsResponse
        assertTrue(paymentResponse.paymentMethods.isNotEmpty())
    }

    @Test
    fun `PUT actualiza los medios de pago correctamente`() = runBlocking {
        tableBusiness.items.add(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val body = UpdatePaymentMethodsRequest(
            paymentMethods = listOf(
                PaymentMethodRecord(id = "cash", name = "Efectivo", type = "CASH", enabled = true, isCashOnDelivery = true),
                PaymentMethodRecord(id = "transfer", name = "Transferencia", type = "TRANSFER", enabled = false, isCashOnDelivery = false),
                PaymentMethodRecord(id = "mp", name = "Mercado Pago", type = "DIGITAL_WALLET", enabled = true, isCashOnDelivery = false)
            )
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/payment-methods",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = Gson().toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val stored = tableBusiness.items.first()
        assertNotNull(stored.paymentMethodsJson)
        assertTrue(stored.paymentMethodsJson!!.contains("CASH"))
        assertTrue(stored.paymentMethodsJson!!.contains("DIGITAL_WALLET"))
    }

    @Test
    fun `PUT con lista vacia devuelve error de validacion`() = runBlocking {
        tableBusiness.items.add(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val body = UpdatePaymentMethodsRequest(paymentMethods = emptyList())

        val response = function.securedExecute(
            business = "biz",
            function = "business/payment-methods",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = Gson().toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `PUT con tipo invalido devuelve error de validacion`() = runBlocking {
        tableBusiness.items.add(Business().apply { name = "biz" })
        seedBusinessAdmin()

        val body = UpdatePaymentMethodsRequest(
            paymentMethods = listOf(
                PaymentMethodRecord(id = "crypto", name = "Bitcoin", type = "CRYPTO", enabled = true)
            )
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/payment-methods",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "PUT"),
            textBody = Gson().toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `usuario no autorizado recibe UnauthorizedException`() = runBlocking {
        tableBusiness.items.add(Business().apply { name = "biz" })
        coEvery { cognito.getUser(any()) } throws RuntimeException("Unauthorized")

        val response = function.securedExecute(
            business = "biz",
            function = "business/payment-methods",
            headers = mapOf("Authorization" to "token"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `GET refleja medios de pago previamente guardados`() = runBlocking {
        val gson = Gson()
        val stored = listOf(
            PaymentMethodRecord(id = "cash", name = "Efectivo", type = "CASH", enabled = true, isCashOnDelivery = true),
            PaymentMethodRecord(id = "mp", name = "Mercado Pago", type = "DIGITAL_WALLET", enabled = true)
        )
        tableBusiness.items.add(Business().apply {
            name = "biz"
            paymentMethodsJson = gson.toJson(stored)
        })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/payment-methods",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        val paymentResponse = response as BusinessPaymentMethodsResponse
        assertEquals(2, paymentResponse.paymentMethods.size)
    }
}
