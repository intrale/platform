package asdo.client

import ar.com.intrale.shared.client.ZoneCheckResponse
import ext.client.CommZoneCheckService
import io.konform.validation.Validation
import io.konform.validation.jsonschema.maximum
import io.konform.validation.jsonschema.minimum
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

/**
 * Implementación de [ToDoCheckAddress]. Valida coordenadas localmente con
 * Konform antes de llamar al servicio (`POST /{business}/zones/check`) y
 * valida la respuesta antes de exponer el resultado a la UI.
 *
 * Privacidad (CA-7):
 * - Nunca loggea `latitude`, `longitude`, `lat`, `lng` ni el objeto entero.
 * - Loggea exclusivamente metadatos: `hasCoords=true inZone=$inZone`.
 *
 * Validación (CA-6):
 * - Rango de coordenadas verificado con Konform DSL antes de llamar al
 *   servicio.
 * - `shippingCost` acotado a [0, 100_000] tras parsear la respuesta. Fuera
 *   de ese rango se devuelve [ZoneCheckException.OutOfRange] sin exponer la
 *   card positiva al usuario.
 */
class DoCheckAddress(
    private val service: CommZoneCheckService
) : ToDoCheckAddress {

    private val logger = LoggerFactory.default.newLogger<DoCheckAddress>()

    private val coordinatesValidation: Validation<ZoneCheckCoordinates> = Validation {
        ZoneCheckCoordinates::latitude {
            minimum(MIN_LATITUDE) hint "Latitud fuera de rango"
            maximum(MAX_LATITUDE) hint "Latitud fuera de rango"
        }
        ZoneCheckCoordinates::longitude {
            minimum(MIN_LONGITUDE) hint "Longitud fuera de rango"
            maximum(MAX_LONGITUDE) hint "Longitud fuera de rango"
        }
    }

    override suspend fun execute(coordinates: ZoneCheckCoordinates): Result<ZoneCheckResult> {
        // Pre-check explícito de NaN/Infinity: Konform basa sus reglas en
        // comparaciones numéricas (>=, <=) que con NaN siempre devuelven
        // false, pero documentamos el caso aparte para que el log sea
        // claro y para evitar dependencias frágiles del comportamiento de
        // NaN en cada plataforma.
        if (!coordinates.isWellFormed()) {
            logger.warning { "Coordenadas inválidas hasCoords=true valid=false" }
            return Result.failure(ZoneCheckException.Invalid)
        }
        val validation = coordinatesValidation(coordinates)
        if (!validation.isValid) {
            logger.warning { "Coordenadas inválidas hasCoords=true valid=false" }
            return Result.failure(ZoneCheckException.Invalid)
        }

        return try {
            logger.info { "Iniciando verificación de zona hasCoords=true" }
            service.checkZone(coordinates.latitude, coordinates.longitude)
                .mapCatching { response -> response.toValidatedResult() }
                .recoverCatching { throwable ->
                    when (throwable) {
                        is ZoneCheckException -> throw throwable
                        else -> {
                            logger.error(throwable) { "Fallo verificando zona" }
                            throw ZoneCheckException.Network(throwable)
                        }
                    }
                }
        } catch (throwable: ZoneCheckException) {
            Result.failure(throwable)
        } catch (throwable: Throwable) {
            logger.error(throwable) { "Error inesperado verificando zona" }
            Result.failure(ZoneCheckException.Unknown)
        }
    }

    private fun ZoneCheckResponse.toValidatedResult(): ZoneCheckResult {
        val cost = shippingCost ?: 0.0
        if (cost.isNaN() || cost.isInfinite() || cost < MIN_SHIPPING_COST || cost > MAX_SHIPPING_COST) {
            logger.warning { "Respuesta inválida hasCoords=true inZone=$inZone outOfRange=true" }
            throw ZoneCheckException.OutOfRange
        }
        logger.info { "Verificación completada hasCoords=true inZone=$inZone" }
        return ZoneCheckResult(
            inZone = inZone,
            shippingCost = cost,
            etaMinutes = etaMinutes,
            zoneId = zoneId,
        )
    }

    companion object {
        const val MIN_LATITUDE: Double = -90.0
        const val MAX_LATITUDE: Double = 90.0
        const val MIN_LONGITUDE: Double = -180.0
        const val MAX_LONGITUDE: Double = 180.0
        const val MIN_SHIPPING_COST: Double = 0.0
        const val MAX_SHIPPING_COST: Double = 100_000.0
    }
}
