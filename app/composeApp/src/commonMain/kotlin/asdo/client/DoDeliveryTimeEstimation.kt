package asdo.client

import ar.com.intrale.BuildKonfig
import ar.com.intrale.shared.delivery.DeliveryEstimationFactorsDTO
import ar.com.intrale.shared.delivery.DeliveryTimeEstimationDTO
import ar.com.intrale.shared.delivery.DeliveryTimeRecordDTO
import ext.client.CommDeliveryTimeEstimationService
import ext.client.toClientException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

/**
 * Caso de uso: obtener estimacion de tiempo para un pedido existente.
 * Traduce el DTO del shared module a modelos de dominio listos para UI.
 */
class DoGetDeliveryTimeEstimation(
    private val service: CommDeliveryTimeEstimationService
) : ToDoGetDeliveryTimeEstimation {

    private val logger = LoggerFactory.default.newLogger<DoGetDeliveryTimeEstimation>()

    override suspend fun execute(orderId: String): Result<DeliveryTimeEstimation> = runCatching {
        logger.info { "Obteniendo estimacion de tiempo para pedido $orderId" }
        service.getEstimation(orderId).getOrThrow().toDomain()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al obtener estimacion para pedido $orderId" }
        throw throwable.toClientException()
    }
}

/**
 * Caso de uso: calcular estimacion preliminar antes de crear el pedido.
 * Usado en ClientCheckoutScreen para anticipar al cliente el tiempo esperado.
 */
class DoCalculateDeliveryTimeEstimation(
    private val service: CommDeliveryTimeEstimationService
) : ToDoCalculateDeliveryTimeEstimation {

    private val logger = LoggerFactory.default.newLogger<DoCalculateDeliveryTimeEstimation>()

    override suspend fun execute(
        deliveryLatitude: Double?,
        deliveryLongitude: Double?,
        deliveryAddress: String?
    ): Result<DeliveryTimeEstimation> = runCatching {
        logger.info { "Calculando estimacion preliminar de tiempo de entrega" }
        service.calculateEstimation(
            deliveryLatitude = deliveryLatitude,
            deliveryLongitude = deliveryLongitude,
            deliveryAddress = deliveryAddress
        ).getOrThrow().toDomain()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al calcular estimacion preliminar" }
        throw throwable.toClientException()
    }
}

/**
 * Caso de uso: registrar el tiempo real de entrega para aprendizaje del modelo.
 */
class DoRecordActualDeliveryTime(
    private val service: CommDeliveryTimeEstimationService
) : ToDoRecordActualDeliveryTime {

    private val logger = LoggerFactory.default.newLogger<DoRecordActualDeliveryTime>()

    override suspend fun execute(
        orderId: String,
        estimatedMinutes: Int,
        actualMinutes: Int,
        activeOrdersAtTime: Int,
        distanceKm: Double?,
        hourOfDay: Int,
        dayOfWeek: Int
    ): Result<Unit> = runCatching {
        logger.info { "Registrando tiempo real $actualMinutes min (estimado $estimatedMinutes) para pedido $orderId" }
        val record = DeliveryTimeRecordDTO(
            orderId = orderId,
            business = BuildKonfig.BUSINESS,
            estimatedMinutes = estimatedMinutes,
            actualMinutes = actualMinutes,
            distanceKm = distanceKm,
            activeOrdersAtTime = activeOrdersAtTime,
            hourOfDay = hourOfDay,
            dayOfWeek = dayOfWeek
        )
        service.recordActualTime(record).getOrThrow()
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al registrar tiempo real para pedido $orderId" }
        throw throwable.toClientException()
    }
}

internal fun DeliveryTimeEstimationDTO.toDomain(): DeliveryTimeEstimation = DeliveryTimeEstimation(
    estimatedMinutes = estimatedMinutes,
    minMinutes = minMinutes,
    maxMinutes = maxMinutes,
    confidence = confidence,
    displayText = displayText,
    factors = factors.toDomain()
)

internal fun DeliveryEstimationFactorsDTO.toDomain(): DeliveryEstimationFactors = DeliveryEstimationFactors(
    activeOrders = activeOrders,
    distanceKm = distanceKm,
    hourOfDay = hourOfDay,
    dayOfWeek = dayOfWeek,
    historicalAvgMinutes = historicalAvgMinutes
)
