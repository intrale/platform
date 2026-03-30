package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

/**
 * Función para el dashboard de anomalías del negocio.
 *
 * Endpoints:
 * - GET  {business}/business/anomalies          — listar anomalías (con filtro optional ?resolved=true/false)
 * - GET  {business}/business/anomalies/config    — obtener configuración de sensibilidad
 * - PUT  {business}/business/anomalies/config    — actualizar configuración de sensibilidad
 * - PUT  {business}/business/anomalies/resolve   — marcar una anomalía como resuelta
 */
class BusinessOrderAnomaliesFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val anomalyRepository: OrderAnomalyRepository,
    private val anomalyConfigStore: AnomalyConfigStore,
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
            // GET config
            method == HttpMethod.Get.value.uppercase() && subPath == "config" -> {
                logger.info("Consultando configuración de anomalías para negocio {}", business)
                val currentConfig = anomalyConfigStore.getConfig(business)
                AnomalyConfigResponse(config = currentConfig)
            }

            // PUT config
            method == HttpMethod.Put.value.uppercase() && subPath == "config" -> {
                logger.info("Actualizando configuración de anomalías para negocio {}", business)
                val request = try {
                    gson.fromJson(textBody, AnomalyConfigUpdateRequest::class.java)
                } catch (e: Exception) {
                    return RequestValidationException("Body inválido para configuración de anomalías")
                }

                val current = anomalyConfigStore.getConfig(business)
                val updated = current.copy(
                    duplicateWindowMinutes = request.duplicateWindowMinutes ?: current.duplicateWindowMinutes,
                    amountMultiplierThreshold = request.amountMultiplierThreshold ?: current.amountMultiplierThreshold,
                    minOrdersForAverage = request.minOrdersForAverage ?: current.minOrdersForAverage,
                    suspiciousAddressMinAccounts = request.suspiciousAddressMinAccounts ?: current.suspiciousAddressMinAccounts
                )
                anomalyConfigStore.setConfig(business, updated)
                AnomalyConfigResponse(config = updated)
            }

            // PUT resolve
            method == HttpMethod.Put.value.uppercase() && subPath == "resolve" -> {
                logger.info("Resolviendo anomalía para negocio {}", business)
                val request = try {
                    gson.fromJson(textBody, AnomalyResolveRequest::class.java)
                } catch (e: Exception) {
                    return RequestValidationException("Body inválido para resolver anomalía")
                }

                if (request.anomalyId.isBlank()) {
                    return RequestValidationException("anomalyId es requerido")
                }

                val resolved = anomalyRepository.resolve(business, request.anomalyId)
                    ?: return ExceptionResponse("Anomalía no encontrada: ${request.anomalyId}", HttpStatusCode.NotFound)

                AnomalyResolveResponse(anomalyId = resolved.id, resolved = true)
            }

            // GET list
            method == HttpMethod.Get.value.uppercase() -> {
                logger.info("Listando anomalías para negocio {}", business)
                val resolvedFilter = headers["X-Query-Resolved"]?.lowercase()

                val all = anomalyRepository.listByBusiness(business)
                val filtered = when (resolvedFilter) {
                    "true" -> all.filter { it.resolved }
                    "false" -> all.filter { !it.resolved }
                    else -> all
                }

                AnomalyListResponse(
                    anomalies = filtered,
                    total = all.size,
                    unresolved = all.count { !it.resolved }
                )
            }

            else -> RequestValidationException("Método no soportado para anomalías: $method ($subPath)")
        }
    }
}

/**
 * Almacén de configuración de sensibilidad por negocio.
 */
class AnomalyConfigStore {
    private val configs = mutableMapOf<String, AnomalyDetectionConfig>()

    fun getConfig(business: String): AnomalyDetectionConfig =
        configs.getOrDefault(business.lowercase(), AnomalyDetectionConfig())

    fun setConfig(business: String, config: AnomalyDetectionConfig) {
        configs[business.lowercase()] = config
    }
}
