package ar.com.intrale

import io.ktor.http.HttpStatusCode
import java.time.Instant
import java.util.UUID

// --- Enums ---

enum class AnomalyType {
    DUPLICATE_ORDER,
    UNUSUAL_AMOUNT,
    SUSPICIOUS_ADDRESS
}

enum class AnomalySeverity {
    LOW, MEDIUM, HIGH
}

// --- Modelo de anomalía ---

data class OrderAnomaly(
    val id: String = UUID.randomUUID().toString(),
    val type: AnomalyType,
    val severity: AnomalySeverity,
    val description: String,
    val details: Map<String, String> = emptyMap(),
    val detectedAt: String = Instant.now().toString()
)

// --- Configuración de sensibilidad ---

data class AnomalyDetectionConfig(
    /** Ventana de tiempo para detección de duplicados (minutos) */
    val duplicateWindowMinutes: Long = 5,
    /** Multiplicador sobre el ticket promedio para considerar monto inusual */
    val amountMultiplierThreshold: Double = 3.0,
    /** Cantidad mínima de pedidos existentes para calcular promedio */
    val minOrdersForAverage: Int = 3,
    /** Cantidad mínima de cuentas distintas en una dirección para considerarla sospechosa */
    val suspiciousAddressMinAccounts: Int = 2
)

// --- Repositorio de anomalías detectadas ---

class OrderAnomalyRepository {

    // key: business → lista de registros de anomalías
    private val anomalies = mutableMapOf<String, MutableList<AnomalyRecord>>()

    fun record(business: String, email: String, orderId: String, anomaly: OrderAnomaly) {
        val record = AnomalyRecord(
            id = anomaly.id,
            business = business,
            email = email,
            orderId = orderId,
            type = anomaly.type,
            severity = anomaly.severity,
            description = anomaly.description,
            details = anomaly.details,
            detectedAt = anomaly.detectedAt,
            resolved = false
        )
        anomalies.getOrPut(business.lowercase()) { mutableListOf() }.add(record)
    }

    fun listByBusiness(business: String): List<AnomalyRecord> =
        anomalies.getOrDefault(business.lowercase(), emptyList()).map { it.copy() }

    fun listUnresolved(business: String): List<AnomalyRecord> =
        listByBusiness(business).filter { !it.resolved }

    fun resolve(business: String, anomalyId: String): AnomalyRecord? {
        val list = anomalies[business.lowercase()] ?: return null
        val index = list.indexOfFirst { it.id == anomalyId }
        if (index < 0) return null
        val resolved = list[index].copy(resolved = true, resolvedAt = Instant.now().toString())
        list[index] = resolved
        return resolved
    }
}

data class AnomalyRecord(
    val id: String = "",
    val business: String = "",
    val email: String = "",
    val orderId: String = "",
    val type: AnomalyType = AnomalyType.DUPLICATE_ORDER,
    val severity: AnomalySeverity = AnomalySeverity.LOW,
    val description: String = "",
    val details: Map<String, String> = emptyMap(),
    val detectedAt: String = "",
    val resolved: Boolean = false,
    val resolvedAt: String? = null
)

// --- Request/Response DTOs ---

data class AnomalyListResponse(
    val anomalies: List<AnomalyRecord> = emptyList(),
    val total: Int = 0,
    val unresolved: Int = 0,
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class AnomalyResolveResponse(
    val anomalyId: String = "",
    val resolved: Boolean = true,
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class AnomalyResolveRequest(
    val anomalyId: String = ""
)

data class AnomalyConfigResponse(
    val config: AnomalyDetectionConfig = AnomalyDetectionConfig(),
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class AnomalyConfigUpdateRequest(
    val duplicateWindowMinutes: Long? = null,
    val amountMultiplierThreshold: Double? = null,
    val minOrdersForAverage: Int? = null,
    val suspiciousAddressMinAccounts: Int? = null
)

data class CreateOrderAnomalyResponse(
    val orderId: String = "",
    val shortCode: String = "",
    val flagged: Boolean = false,
    val anomalies: List<AnomalyInfo> = emptyList(),
    val status: HttpStatusCode = HttpStatusCode.Created
) : Response(statusCode = status)

data class AnomalyInfo(
    val type: String = "",
    val severity: String = "",
    val description: String = ""
)
