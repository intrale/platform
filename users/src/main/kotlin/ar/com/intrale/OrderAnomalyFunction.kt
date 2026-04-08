package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import java.time.Instant

// --- Requests ---

/**
 * Request para analizar un pedido especifico.
 */
data class AnalyzeOrderRequest(
    val orderId: String = "",
    val clientEmail: String = ""
)

/**
 * Request para actualizar la configuracion de sensibilidad.
 */
data class UpdateAnomalyConfigRequest(
    val duplicateWindowMinutes: Long = 5,
    val amountThresholdMultiplier: Double = 3.0,
    val maxOrdersPerHour: Int = 5,
    val flagThreshold: Double = 0.5
)

/**
 * Request para resolver (aprobar/rechazar) un pedido flaggeado.
 */
data class ResolveAnomalyRequest(
    val orderId: String = "",
    val action: String = "", // "approve" o "reject"
    val reason: String? = null
)

// --- Responses ---

/**
 * Respuesta con el resultado del analisis de anomalias de un pedido.
 */
data class AnomalyAnalysisResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val orderId: String = "",
    val flagged: Boolean = false,
    val requiresManualReview: Boolean = false,
    val anomalies: List<AnomalyPayload> = emptyList(),
    val analyzedAt: String = "",
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class AnomalyPayload(
    val type: String = "",
    val severity: String = "",
    val description: String = "",
    val score: Double = 0.0
)

/**
 * Respuesta con la lista de pedidos flaggeados del negocio.
 */
data class FlaggedOrdersResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val orders: List<FlaggedOrderPayload> = emptyList(),
    val totalFlagged: Int = 0,
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class FlaggedOrderPayload(
    val orderId: String = "",
    val shortCode: String? = null,
    val clientEmail: String = "",
    val total: Double = 0.0,
    val anomalies: List<AnomalyPayload> = emptyList(),
    val flaggedAt: String = "",
    val resolved: Boolean = false,
    val resolution: String? = null
)

/**
 * Respuesta con la configuracion actual de sensibilidad.
 */
data class AnomalyConfigResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val config: AnomalyDetectionConfig = AnomalyDetectionConfig(),
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Respuesta al resolver una anomalia.
 */
data class ResolveAnomalyResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val orderId: String = "",
    val action: String = "",
    val message: String = "",
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Respuesta con el historial de anomalias detectadas.
 */
data class AnomalyHistoryResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val history: List<AnomalyHistoryEntry> = emptyList(),
    val totalEntries: Int = 0,
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class AnomalyHistoryEntry(
    val orderId: String = "",
    val shortCode: String? = null,
    val clientEmail: String = "",
    val anomalies: List<AnomalyPayload> = emptyList(),
    val flaggedAt: String = "",
    val resolved: Boolean = false,
    val resolution: String? = null,
    val resolvedAt: String? = null
)

// --- Repository (in-memory) ---

/**
 * Registro de anomalia almacenado en el repositorio.
 */
data class AnomalyRecord(
    val orderId: String,
    val shortCode: String? = null,
    val clientEmail: String,
    val business: String,
    val total: Double,
    val anomalies: List<DetectedAnomaly>,
    val flaggedAt: String,
    var resolved: Boolean = false,
    var resolution: String? = null,
    var resolvedAt: String? = null
)

/**
 * Repositorio in-memory para anomalias detectadas.
 */
class AnomalyRepository {
    private val records = mutableListOf<AnomalyRecord>()
    private val configs = mutableMapOf<String, AnomalyDetectionConfig>()

    fun save(record: AnomalyRecord) {
        records.add(record)
    }

    fun listFlaggedForBusiness(business: String): List<AnomalyRecord> =
        records.filter { it.business == business }.sortedByDescending { it.flaggedAt }

    fun listUnresolvedForBusiness(business: String): List<AnomalyRecord> =
        records.filter { it.business == business && !it.resolved }.sortedByDescending { it.flaggedAt }

    fun findByOrderId(business: String, orderId: String): AnomalyRecord? =
        records.firstOrNull { it.business == business && it.orderId == orderId }

    fun resolve(business: String, orderId: String, resolution: String): AnomalyRecord? {
        val record = findByOrderId(business, orderId) ?: return null
        record.resolved = true
        record.resolution = resolution
        record.resolvedAt = Instant.now().toString()
        return record
    }

    fun getConfig(business: String): AnomalyDetectionConfig =
        configs.getOrDefault(business, AnomalyDetectionConfig())

    fun saveConfig(business: String, config: AnomalyDetectionConfig) {
        configs[business] = config
    }
}

// --- Function ---

/**
 * Endpoint protegido para gestion de anomalias en pedidos del negocio.
 *
 * Rutas:
 * - GET  /{business}/business/anomalies              — Lista pedidos flaggeados
 * - GET  /{business}/business/anomalies/history       — Historial completo de anomalias
 * - GET  /{business}/business/anomalies/config        — Obtener configuracion de sensibilidad
 * - POST /{business}/business/anomalies/analyze       — Analizar un pedido especifico
 * - PUT  /{business}/business/anomalies/config        — Actualizar configuracion de sensibilidad
 * - PUT  /{business}/business/anomalies/resolve       — Resolver (aprobar/rechazar) un pedido flaggeado
 */
class OrderAnomalyFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val detectionService: OrderAnomalyDetectionService,
    private val anomalyRepository: AnomalyRepository,
    private val orderRepository: ClientOrderRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config, logger, jwtValidator) {

    private val gson = Gson()

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()
        val subPath = function.removePrefix("business/anomalies").trimStart('/')

        return when {
            // POST /business/anomalies/analyze — Analizar un pedido
            method == HttpMethod.Post.value.uppercase() && subPath == "analyze" -> handleAnalyze(business, textBody)

            // GET /business/anomalies/history — Historial de anomalias
            method == HttpMethod.Get.value.uppercase() && subPath == "history" -> handleHistory(business)

            // GET /business/anomalies/config — Obtener config
            method == HttpMethod.Get.value.uppercase() && subPath == "config" -> handleGetConfig(business)

            // PUT /business/anomalies/config — Actualizar config
            method == HttpMethod.Put.value.uppercase() && subPath == "config" -> handleUpdateConfig(business, textBody)

            // PUT /business/anomalies/resolve — Resolver anomalia
            method == HttpMethod.Put.value.uppercase() && subPath == "resolve" -> handleResolve(business, textBody)

            // GET /business/anomalies — Listar pedidos flaggeados pendientes
            method == HttpMethod.Get.value.uppercase() && subPath.isBlank() -> handleListFlagged(business)

            else -> RequestValidationException("Metodo no soportado para anomalias: $method ($subPath)")
        }
    }

    private fun handleAnalyze(business: String, textBody: String): Response {
        val request = parseBody<AnalyzeOrderRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (request.orderId.isBlank()) {
            return RequestValidationException("orderId es requerido")
        }
        if (request.clientEmail.isBlank()) {
            return RequestValidationException("clientEmail es requerido")
        }

        val order = orderRepository.getOrder(business, request.clientEmail, request.orderId)
            ?: return ExceptionResponse("Pedido no encontrado", HttpStatusCode.NotFound)

        val detectionConfig = anomalyRepository.getConfig(business)
        val result = detectionService.analyze(business, request.clientEmail, order, detectionConfig)

        // Si hay anomalias, registrar en el repositorio
        if (result.flagged) {
            anomalyRepository.save(
                AnomalyRecord(
                    orderId = result.orderId,
                    shortCode = order.shortCode,
                    clientEmail = request.clientEmail,
                    business = business,
                    total = order.total,
                    anomalies = result.anomalies,
                    flaggedAt = Instant.now().toString()
                )
            )
        }

        val anomalyPayloads = result.anomalies.map { it.toPayload() }
        return AnomalyAnalysisResponse(
            orderId = result.orderId,
            flagged = result.flagged,
            requiresManualReview = result.requiresManualReview,
            anomalies = anomalyPayloads,
            analyzedAt = Instant.now().toString()
        )
    }

    private fun handleListFlagged(business: String): Response {
        logger.info("Listando pedidos flaggeados para negocio {}", business)
        val flagged = anomalyRepository.listUnresolvedForBusiness(business)
        val payloads = flagged.map { record ->
            FlaggedOrderPayload(
                orderId = record.orderId,
                shortCode = record.shortCode,
                clientEmail = record.clientEmail,
                total = record.total,
                anomalies = record.anomalies.map { it.toPayload() },
                flaggedAt = record.flaggedAt,
                resolved = record.resolved,
                resolution = record.resolution
            )
        }
        return FlaggedOrdersResponse(
            orders = payloads,
            totalFlagged = payloads.size
        )
    }

    private fun handleHistory(business: String): Response {
        logger.info("Consultando historial de anomalias para negocio {}", business)
        val all = anomalyRepository.listFlaggedForBusiness(business)
        val entries = all.map { record ->
            AnomalyHistoryEntry(
                orderId = record.orderId,
                shortCode = record.shortCode,
                clientEmail = record.clientEmail,
                anomalies = record.anomalies.map { it.toPayload() },
                flaggedAt = record.flaggedAt,
                resolved = record.resolved,
                resolution = record.resolution,
                resolvedAt = record.resolvedAt
            )
        }
        return AnomalyHistoryResponse(
            history = entries,
            totalEntries = entries.size
        )
    }

    private fun handleGetConfig(business: String): Response {
        logger.debug("Obteniendo config de anomalias para negocio {}", business)
        val detectionConfig = anomalyRepository.getConfig(business)
        return AnomalyConfigResponse(config = detectionConfig)
    }

    private fun handleUpdateConfig(business: String, textBody: String): Response {
        val request = parseBody<UpdateAnomalyConfigRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (request.duplicateWindowMinutes < 1 || request.duplicateWindowMinutes > 60) {
            return RequestValidationException("duplicateWindowMinutes debe estar entre 1 y 60")
        }
        if (request.amountThresholdMultiplier < 1.0 || request.amountThresholdMultiplier > 20.0) {
            return RequestValidationException("amountThresholdMultiplier debe estar entre 1.0 y 20.0")
        }
        if (request.maxOrdersPerHour < 1 || request.maxOrdersPerHour > 100) {
            return RequestValidationException("maxOrdersPerHour debe estar entre 1 y 100")
        }
        if (request.flagThreshold < 0.0 || request.flagThreshold > 1.0) {
            return RequestValidationException("flagThreshold debe estar entre 0.0 y 1.0")
        }

        val newConfig = AnomalyDetectionConfig(
            duplicateWindowMinutes = request.duplicateWindowMinutes,
            amountThresholdMultiplier = request.amountThresholdMultiplier,
            maxOrdersPerHour = request.maxOrdersPerHour,
            flagThreshold = request.flagThreshold
        )
        anomalyRepository.saveConfig(business, newConfig)

        logger.info("Configuracion de anomalias actualizada para negocio {}", business)
        return AnomalyConfigResponse(config = newConfig)
    }

    private fun handleResolve(business: String, textBody: String): Response {
        val request = parseBody<ResolveAnomalyRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (request.orderId.isBlank()) {
            return RequestValidationException("orderId es requerido")
        }
        if (request.action !in listOf("approve", "reject")) {
            return RequestValidationException("action debe ser 'approve' o 'reject'")
        }

        val record = anomalyRepository.findByOrderId(business, request.orderId)
            ?: return ExceptionResponse("No se encontro anomalia para el pedido", HttpStatusCode.NotFound)

        if (record.resolved) {
            return RequestValidationException("Esta anomalia ya fue resuelta: ${record.resolution}")
        }

        val resolution = "${request.action}: ${request.reason ?: "Sin motivo especificado"}"
        anomalyRepository.resolve(business, request.orderId, resolution)

        logger.info("Anomalia del pedido {} resuelta con accion '{}' en negocio {}",
            request.orderId, request.action, business)

        return ResolveAnomalyResponse(
            orderId = request.orderId,
            action = request.action,
            message = if (request.action == "approve") "Pedido aprobado manualmente" else "Pedido rechazado"
        )
    }

    private fun DetectedAnomaly.toPayload() = AnomalyPayload(
        type = type.name,
        severity = severity.name,
        description = description,
        score = score
    )
}
