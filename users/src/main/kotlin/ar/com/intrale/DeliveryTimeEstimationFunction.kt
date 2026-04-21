package ar.com.intrale

import com.auth0.jwt.JWT
import com.google.gson.Gson
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

/**
 * Funcion para estimar el tiempo de entrega de un pedido.
 *
 * Endpoints:
 * - GET  delivery/time-estimation?orderId=xxx  -> Obtener estimacion para un pedido
 * - POST delivery/time-estimation              -> Calcular estimacion con parametros custom
 * - PUT  delivery/time-estimation/actual        -> Registrar tiempo real de entrega
 *
 * @see DeliveryTimeEstimationService para la logica de estimacion
 */
class DeliveryTimeEstimationFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val estimationService: DeliveryTimeEstimationService,
    private val estimationRepository: DeliveryTimeEstimationRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config, logger, jwtValidator) {

    private val gson = Gson()

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        val email = resolveEmail(headers) ?: return UnauthorizedException()
        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()
        val functionPath = headers["X-Function-Path"] ?: function

        return when (method) {
            HttpMethod.Get.value.uppercase() -> handleGetEstimation(business, email, headers)
            HttpMethod.Post.value.uppercase() -> handlePostEstimation(business, email, textBody)
            HttpMethod.Put.value.uppercase() -> {
                if (functionPath.contains("actual")) {
                    handleRecordActualTime(business, email, textBody)
                } else {
                    RequestValidationException("Unsupported PUT path: $functionPath")
                }
            }
            else -> RequestValidationException("Unsupported method for delivery time estimation: $method")
        }
    }

    /**
     * GET: Obtener estimacion de tiempo para el negocio actual.
     * Parametros opcionales via query: orderId, distanceKm
     */
    private fun handleGetEstimation(
        business: String,
        email: String,
        headers: Map<String, String>
    ): Response {
        logger.info("Solicitando estimacion de tiempo de entrega para cliente $email en negocio $business")

        val distanceKm = headers["X-Query-distanceKm"]?.toDoubleOrNull()

        val result = estimationService.estimate(
            business = business,
            distanceKm = distanceKm
        )

        return DeliveryTimeEstimationResponse(
            estimatedMinutes = result.estimatedMinutes,
            minMinutes = result.minMinutes,
            maxMinutes = result.maxMinutes,
            confidence = result.confidence,
            displayText = result.displayText,
            factors = EstimationFactorsPayload(
                activeOrders = result.activeOrders,
                distanceKm = result.distanceKm,
                hourOfDay = result.hourOfDay,
                dayOfWeek = result.dayOfWeek,
                historicalAvgMinutes = result.historicalAvgMinutes
            ),
            status = HttpStatusCode.OK
        )
    }

    /**
     * POST: Calcular estimacion con parametros completos en el body.
     * Tambien registra la estimacion para tracking.
     */
    private fun handlePostEstimation(
        business: String,
        email: String,
        textBody: String
    ): Response {
        logger.info("Calculando estimacion de tiempo de entrega para cliente $email en negocio $business")

        val request = runCatching {
            gson.fromJson(textBody, EstimationRequest::class.java)
        }.getOrElse {
            return RequestValidationException("Body de request invalido: ${it.message}")
        }

        val result = estimationService.estimate(
            business = business,
            distanceKm = request.distanceKm
        )

        // Registrar estimacion para aprendizaje si hay orderId
        if (!request.orderId.isNullOrBlank()) {
            estimationRepository.recordEstimation(
                business = business,
                record = DeliveryTimeRecord(
                    orderId = request.orderId,
                    business = business,
                    estimatedMinutes = result.estimatedMinutes,
                    distanceKm = result.distanceKm,
                    activeOrdersAtTime = result.activeOrders,
                    hourOfDay = result.hourOfDay,
                    dayOfWeek = result.dayOfWeek
                )
            )
        }

        return DeliveryTimeEstimationResponse(
            estimatedMinutes = result.estimatedMinutes,
            minMinutes = result.minMinutes,
            maxMinutes = result.maxMinutes,
            confidence = result.confidence,
            displayText = result.displayText,
            factors = EstimationFactorsPayload(
                activeOrders = result.activeOrders,
                distanceKm = result.distanceKm,
                hourOfDay = result.hourOfDay,
                dayOfWeek = result.dayOfWeek,
                historicalAvgMinutes = result.historicalAvgMinutes
            ),
            status = HttpStatusCode.OK
        )
    }

    /**
     * PUT: Registrar el tiempo real de entrega para mejorar predicciones futuras.
     * Compara estimado vs real y almacena la diferencia.
     */
    private fun handleRecordActualTime(
        business: String,
        email: String,
        textBody: String
    ): Response {
        logger.info("Registrando tiempo real de entrega para negocio $business por $email")

        val request = runCatching {
            gson.fromJson(textBody, RecordActualTimeRequest::class.java)
        }.getOrElse {
            return RequestValidationException("Body de request invalido: ${it.message}")
        }

        if (request.orderId.isBlank()) {
            return RequestValidationException("orderId es requerido")
        }
        if (request.actualMinutes <= 0) {
            return RequestValidationException("actualMinutes debe ser mayor a 0")
        }

        val updated = estimationRepository.recordActualTime(
            business = business,
            orderId = request.orderId,
            actualMinutes = request.actualMinutes
        )

        if (updated == null) {
            logger.warn("No se encontro registro de estimacion para orderId=${request.orderId} en negocio $business")
            return RequestValidationException("No se encontro estimacion previa para el pedido ${request.orderId}")
        }

        val deviation = request.actualMinutes - updated.estimatedMinutes
        val deviationText = if (deviation > 0) "+$deviation" else "$deviation"
        logger.info(
            "Tiempo real registrado para pedido ${request.orderId}: " +
            "estimado=${updated.estimatedMinutes}min, real=${request.actualMinutes}min, " +
            "desviacion=${deviationText}min"
        )

        return RecordActualTimeResponse(
            orderId = request.orderId,
            estimatedMinutes = updated.estimatedMinutes,
            actualMinutes = request.actualMinutes,
            deviationMinutes = deviation,
            message = "Tiempo real registrado correctamente (desviacion: ${deviationText} min)",
            status = HttpStatusCode.OK
        )
    }

    private fun resolveEmail(headers: Map<String, String>): String? {
        val token = headers["Authorization"] ?: headers["authorization"]
        val decoded = token
            ?.removePrefix("Bearer ")
            ?.takeIf { it.isNotBlank() }
            ?.let { runCatching { JWT.decode(it) }.getOrNull() }

        return decoded?.getClaim("email")?.asString()
            ?: decoded?.subject
            ?: headers["X-Debug-User"]
    }
}

/**
 * Request interno para POST de estimacion.
 */
data class EstimationRequest(
    val orderId: String? = null,
    val distanceKm: Double? = null,
    val deliveryAddress: String? = null
)
