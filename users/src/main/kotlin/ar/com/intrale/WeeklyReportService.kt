package ar.com.intrale

import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * Metricas semanales calculadas del negocio.
 */
data class WeeklyMetrics(
    val totalRevenue: Double = 0.0,
    val orderCount: Int = 0,
    val averageTicket: Double = 0.0,
    val previousWeekRevenue: Double = 0.0,
    val previousWeekOrderCount: Int = 0,
    val revenueChangePercent: Double = 0.0,
    val orderCountChangePercent: Double = 0.0,
    val topProducts: List<TopProduct> = emptyList()
)

data class TopProduct(
    val name: String,
    val quantity: Int,
    val revenue: Double
)

/**
 * Resultado de la generacion de un reporte semanal.
 */
data class WeeklyReportResult(
    val metrics: WeeklyMetrics,
    val reportText: String,
    val sent: Boolean,
    val sentTo: String?
)

/**
 * Respuesta estructurada del agente IA para el reporte.
 */
data class AiReportResponse(
    val report: String = "",
    val recommendation: String = ""
)

/**
 * Servicio que calcula metricas semanales y genera el texto del reporte usando IA.
 */
interface WeeklyReportService {
    suspend fun generateReport(business: Business, businessName: String, orders: List<BusinessOrderItem>): WeeklyReportResult
}

class DefaultWeeklyReportService(
    private val aiService: AiResponseService,
    private val telegramService: MessageDeliveryService,
    private val whatsAppService: MessageDeliveryService
) : WeeklyReportService {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
    private val gson = Gson()
    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    override suspend fun generateReport(
        business: Business,
        businessName: String,
        orders: List<BusinessOrderItem>
    ): WeeklyReportResult {
        val now = Instant.now()
        val oneWeekAgo = now.minus(7, ChronoUnit.DAYS)
        val twoWeeksAgo = now.minus(14, ChronoUnit.DAYS)

        // Filtrar pedidos de la semana actual y anterior
        val thisWeekOrders = orders.filter { order ->
            val createdAt = order.order.createdAt?.let { parseInstant(it) }
            createdAt != null && createdAt.isAfter(oneWeekAgo)
        }

        val previousWeekOrders = orders.filter { order ->
            val createdAt = order.order.createdAt?.let { parseInstant(it) }
            createdAt != null && createdAt.isAfter(twoWeeksAgo) && createdAt.isBefore(oneWeekAgo)
        }

        // Calcular metricas
        val metrics = calculateMetrics(thisWeekOrders, previousWeekOrders)

        // Generar texto del reporte con IA
        val reportText = generateReportText(businessName, metrics)

        // Enviar el reporte por el canal configurado
        var sent = false
        var sentTo: String? = null

        if (business.weeklyReportEnabled && !business.weeklyReportContactId.isNullOrBlank()) {
            val deliveryService = when (business.weeklyReportContactType?.lowercase()) {
                "telegram" -> telegramService
                "whatsapp" -> whatsAppService
                else -> {
                    logger.warn("Tipo de contacto desconocido: ${business.weeklyReportContactType}")
                    null
                }
            }

            if (deliveryService != null) {
                sent = deliveryService.sendMessage(business.weeklyReportContactId!!, reportText)
                if (sent) {
                    sentTo = "${business.weeklyReportContactType}:${business.weeklyReportContactId}"
                }
            }
        }

        return WeeklyReportResult(
            metrics = metrics,
            reportText = reportText,
            sent = sent,
            sentTo = sentTo
        )
    }

    internal fun calculateMetrics(
        thisWeekOrders: List<BusinessOrderItem>,
        previousWeekOrders: List<BusinessOrderItem>
    ): WeeklyMetrics {
        val totalRevenue = thisWeekOrders.sumOf { it.order.total }
        val orderCount = thisWeekOrders.size
        val averageTicket = if (orderCount > 0) totalRevenue / orderCount else 0.0

        val prevRevenue = previousWeekOrders.sumOf { it.order.total }
        val prevOrderCount = previousWeekOrders.size

        val revenueChange = if (prevRevenue > 0) ((totalRevenue - prevRevenue) / prevRevenue) * 100 else 0.0
        val orderCountChange = if (prevOrderCount > 0) ((orderCount - prevOrderCount).toDouble() / prevOrderCount) * 100 else 0.0

        // Calcular top 5 productos
        val productCounts = mutableMapOf<String, Pair<Int, Double>>()
        thisWeekOrders.forEach { item ->
            item.order.items.forEach { orderItem ->
                val name = orderItem.name.ifBlank { orderItem.productName }
                val current = productCounts.getOrDefault(name, Pair(0, 0.0))
                productCounts[name] = Pair(
                    current.first + orderItem.quantity,
                    current.second + orderItem.subtotal
                )
            }
        }

        val topProducts = productCounts.entries
            .sortedByDescending { it.value.first }
            .take(5)
            .map { TopProduct(name = it.key, quantity = it.value.first, revenue = it.value.second) }

        return WeeklyMetrics(
            totalRevenue = totalRevenue,
            orderCount = orderCount,
            averageTicket = averageTicket,
            previousWeekRevenue = prevRevenue,
            previousWeekOrderCount = prevOrderCount,
            revenueChangePercent = revenueChange,
            orderCountChangePercent = orderCountChange,
            topProducts = topProducts
        )
    }

    internal suspend fun generateReportText(businessName: String, metrics: WeeklyMetrics): String {
        val apiKey = System.getenv("ANTHROPIC_API_KEY") ?: ""
        if (apiKey.isBlank()) {
            logger.warn("ANTHROPIC_API_KEY no configurada, usando reporte con formato basico")
            return buildFallbackReport(businessName, metrics)
        }

        val systemPrompt = buildReportPrompt(businessName, metrics)

        val request = ClaudeRequest(
            model = "claude-sonnet-4-20250514",
            maxTokens = 1024,
            system = systemPrompt,
            messages = listOf(ClaudeMessage(role = "user", content = "Genera el reporte semanal ejecutivo."))
        )

        return try {
            val httpRequest = HttpRequest.newBuilder()
                .uri(URI.create("https://api.anthropic.com/v1/messages"))
                .header("Content-Type", "application/json")
                .header("x-api-key", apiKey)
                .header("anthropic-version", "2023-06-01")
                .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(request)))
                .timeout(Duration.ofSeconds(20))
                .build()

            val httpResponse = httpClient.send(httpRequest, HttpResponse.BodyHandlers.ofString())

            if (httpResponse.statusCode() == 200) {
                val apiResponse = gson.fromJson(httpResponse.body(), ClaudeApiResponse::class.java)
                val text = apiResponse.content.firstOrNull()?.text ?: ""
                if (text.isNotBlank()) text else buildFallbackReport(businessName, metrics)
            } else {
                logger.error("Claude API error generando reporte: status=${httpResponse.statusCode()}")
                buildFallbackReport(businessName, metrics)
            }
        } catch (e: Exception) {
            logger.error("Error generando reporte con IA", e)
            buildFallbackReport(businessName, metrics)
        }
    }

    private fun buildReportPrompt(businessName: String, metrics: WeeklyMetrics): String {
        val sb = StringBuilder()
        sb.appendLine("Sos el asistente de negocios de Intrale.")
        sb.appendLine("Genera un reporte semanal ejecutivo para el negocio '$businessName'.")
        sb.appendLine()
        sb.appendLine("=== METRICAS DE LA SEMANA ===")
        sb.appendLine("Ventas totales: \$${String.format("%.2f", metrics.totalRevenue)}")
        sb.appendLine("Cantidad de pedidos: ${metrics.orderCount}")
        sb.appendLine("Ticket promedio: \$${String.format("%.2f", metrics.averageTicket)}")
        sb.appendLine()
        sb.appendLine("=== COMPARACION CON SEMANA ANTERIOR ===")
        sb.appendLine("Ventas semana anterior: \$${String.format("%.2f", metrics.previousWeekRevenue)}")
        sb.appendLine("Pedidos semana anterior: ${metrics.previousWeekOrderCount}")
        sb.appendLine("Variacion ventas: ${String.format("%.1f", metrics.revenueChangePercent)}%")
        sb.appendLine("Variacion pedidos: ${String.format("%.1f", metrics.orderCountChangePercent)}%")

        if (metrics.topProducts.isNotEmpty()) {
            sb.appendLine()
            sb.appendLine("=== TOP 5 PRODUCTOS ===")
            metrics.topProducts.forEachIndexed { i, p ->
                sb.appendLine("${i + 1}. ${p.name} — ${p.quantity} unidades (\$${String.format("%.2f", p.revenue)})")
            }
        }

        sb.appendLine()
        sb.appendLine("=== INSTRUCCIONES DE FORMATO ===")
        sb.appendLine("- Formato HTML (para Telegram): usa <b>negrita</b>, saltos de linea")
        sb.appendLine("- Emojis para hacerlo visual y atractivo")
        sb.appendLine("- Incluir una recomendacion accionable al final")
        sb.appendLine("- Maximo 2000 caracteres")
        sb.appendLine("- El link para ver mas detalle: https://app.intrale.com/$businessName/dashboard")
        sb.appendLine("- NO uses markdown, usa HTML tags")
        sb.appendLine("- Responde UNICAMENTE el texto del reporte, sin explicaciones adicionales")

        return sb.toString()
    }

    internal fun buildFallbackReport(businessName: String, metrics: WeeklyMetrics): String {
        val sb = StringBuilder()
        sb.appendLine("\uD83D\uDCCA <b>Reporte Semanal — $businessName</b>")
        sb.appendLine()
        sb.appendLine("\uD83D\uDCB0 <b>Ventas:</b> \$${String.format("%.2f", metrics.totalRevenue)}")
        sb.appendLine("\uD83D\uDCE6 <b>Pedidos:</b> ${metrics.orderCount}")
        sb.appendLine("\uD83C\uDFAB <b>Ticket promedio:</b> \$${String.format("%.2f", metrics.averageTicket)}")
        sb.appendLine()

        val revenueArrow = if (metrics.revenueChangePercent >= 0) "\u2B06\uFE0F" else "\u2B07\uFE0F"
        sb.appendLine("$revenueArrow <b>vs semana anterior:</b> ${String.format("%.1f", metrics.revenueChangePercent)}% ventas")

        if (metrics.topProducts.isNotEmpty()) {
            sb.appendLine()
            sb.appendLine("\uD83C\uDFC6 <b>Top productos:</b>")
            metrics.topProducts.forEachIndexed { i, p ->
                sb.appendLine("  ${i + 1}. ${p.name} (${p.quantity}u)")
            }
        }

        sb.appendLine()
        sb.appendLine("\uD83D\uDC49 <a href=\"https://app.intrale.com/$businessName/dashboard\">Ver detalle completo</a>")

        return sb.toString()
    }

    private fun parseInstant(timestamp: String): Instant? {
        return try {
            Instant.parse(timestamp)
        } catch (e: Exception) {
            null
        }
    }
}
