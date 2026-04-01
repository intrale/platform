package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

/**
 * Respuesta del endpoint de generacion de reporte semanal.
 */
class WeeklyReportResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val totalRevenue: Double = 0.0,
    val orderCount: Int = 0,
    val averageTicket: Double = 0.0,
    val revenueChangePercent: Double = 0.0,
    val orderCountChangePercent: Double = 0.0,
    val topProducts: List<TopProduct> = emptyList(),
    val reportText: String = "",
    val sent: Boolean = false,
    val sentTo: String? = null,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Endpoint protegido para generar y enviar el reporte semanal del negocio.
 * Puede ser invocado manualmente por el admin o por un job programado.
 *
 * POST /{business}/business/weekly-report -> Genera y envia el reporte
 * GET /{business}/business/weekly-report -> Genera y retorna sin enviar
 */
class WeeklyReportFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableBusiness: DynamoDbTable<Business>,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    private val orderRepository: ClientOrderRepository,
    private val reportService: WeeklyReportService,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando business/weekly-report para negocio=$business")

        requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN
        ) ?: return UnauthorizedException()

        val key = Business().apply { name = business }
        val businessEntity = tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        // Obtener todas las ordenes del negocio
        val allOrders = orderRepository.listAllOrdersForBusiness(business)

        return try {
            val result = reportService.generateReport(businessEntity, business, allOrders)

            logger.info("Reporte semanal generado para negocio=$business: " +
                    "${result.metrics.orderCount} pedidos, \$${String.format("%.2f", result.metrics.totalRevenue)} ventas, " +
                    "enviado=${result.sent}")

            WeeklyReportResponse(
                totalRevenue = result.metrics.totalRevenue,
                orderCount = result.metrics.orderCount,
                averageTicket = result.metrics.averageTicket,
                revenueChangePercent = result.metrics.revenueChangePercent,
                orderCountChangePercent = result.metrics.orderCountChangePercent,
                topProducts = result.metrics.topProducts,
                reportText = result.reportText,
                sent = result.sent,
                sentTo = result.sentTo
            )
        } catch (e: Exception) {
            logger.error("Error generando reporte semanal para negocio=$business", e)
            ExceptionResponse(
                "Error generando reporte semanal: ${e.message}",
                HttpStatusCode.InternalServerError
            )
        }
    }
}
