package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.GetUserResponse
import io.ktor.http.HttpStatusCode
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Implementacion fake del servicio de reportes semanales para tests.
 */
class FakeWeeklyReportService : WeeklyReportService {
    var resultToReturn = WeeklyReportResult(
        metrics = WeeklyMetrics(
            totalRevenue = 1000.0,
            orderCount = 15,
            averageTicket = 66.67,
            revenueChangePercent = 10.0,
            orderCountChangePercent = 5.0,
            topProducts = listOf(TopProduct("Pizza", 8, 400.0))
        ),
        reportText = "Reporte de prueba",
        sent = true,
        sentTo = "telegram:123"
    )
    var shouldThrow = false

    override suspend fun generateReport(
        business: Business,
        businessName: String,
        orders: List<BusinessOrderItem>
    ): WeeklyReportResult {
        if (shouldThrow) throw RuntimeException("Error de prueba")
        return resultToReturn
    }
}

class WeeklyReportFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val tableBusiness = InMemoryDynamoDbTable<Business>(
        "business",
        TableSchema.fromBean(Business::class.java)
    ) { it.name ?: "" }
    private val tableProfiles = InMemoryDynamoDbTable<UserBusinessProfile>(
        "profiles",
        TableSchema.fromBean(UserBusinessProfile::class.java)
    ) { it.compositeKey ?: "" }
    private val orderRepository = ClientOrderRepository()
    private val fakeReportService = FakeWeeklyReportService()

    private val function = WeeklyReportFunction(
        config, logger, cognito, tableBusiness, tableProfiles, orderRepository, fakeReportService
    )

    private fun seedBusinessAdmin() {
        tableProfiles.putItem(UserBusinessProfile().apply {
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
    fun `genera reporte semanal exitosamente`() = runBlocking {
        tableBusiness.putItem(Business().apply {
            name = "biz"
            weeklyReportEnabled = true
            weeklyReportContactType = "telegram"
            weeklyReportContactId = "123"
        })
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/weekly-report",
            headers = mapOf("Authorization" to "token"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is WeeklyReportResponse)
        val reportResponse = response as WeeklyReportResponse
        assertEquals(1000.0, reportResponse.totalRevenue)
        assertEquals(15, reportResponse.orderCount)
        assertTrue(reportResponse.sent)
        assertEquals("telegram:123", reportResponse.sentTo)
    }

    @Test
    fun `error en generacion de reporte devuelve InternalServerError`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        seedBusinessAdmin()
        fakeReportService.shouldThrow = true

        val response = function.securedExecute(
            business = "biz",
            function = "business/weekly-report",
            headers = mapOf("Authorization" to "token"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.InternalServerError, response.statusCode)
    }

    @Test
    fun `usuario no autorizado recibe UnauthorizedException`() = runBlocking {
        tableBusiness.putItem(Business().apply { name = "biz" })
        coEvery { cognito.getUser(any()) } throws RuntimeException("Unauthorized")

        val response = function.securedExecute(
            business = "biz",
            function = "business/weekly-report",
            headers = mapOf("Authorization" to "token"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `negocio inexistente devuelve NotFound`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/weekly-report",
            headers = mapOf("Authorization" to "token"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }
}
