package asdo.business.delivery

import ext.business.CommDeliveryZonesCache
import ext.business.CommDeliveryZonesService
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

/**
 * Caso de uso "listar zonas de delivery" con fallback a cache offline (split 1 #2420).
 *
 * Flujo:
 * 1. Llama al backend (`service.list(businessId)`).
 * 2. Si OK: refresca el cache y retorna las zonas frescas.
 * 3. Si falla: lee del cache. Si el cache tiene datos -> success con zonas guardadas
 *    (la UI muestra el banner offline). Si el cache esta vacio -> failure con
 *    DoListDeliveryZonesException (la UI muestra error con CTA reintentar).
 *
 * Patron de error: try/recover con .toDoListDeliveryZonesException() — alineado con
 * el patron del proyecto descrito en docs/manejo-errores-do.md.
 */
class DoListDeliveryZones(
    private val service: CommDeliveryZonesService,
    private val cache: CommDeliveryZonesCache,
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ToDoListDeliveryZones {

    private val logger = loggerFactory.newLogger<DoListDeliveryZones>()

    override suspend fun execute(businessId: String): Result<ListDeliveryZonesOutput> {
        return try {
            service.list(businessId)
                .mapCatching { freshZones ->
                    cache.write(businessId, freshZones)
                    ListDeliveryZonesOutput(zones = freshZones, fromCache = false)
                }
                .recoverCatching { networkError ->
                    logger.warning { "Backend fallo (${networkError.message}), intentando cache" }
                    val cached = cache.read(businessId)
                    if (cached.isNotEmpty()) {
                        logger.info { "Zonas servidas desde cache offline (${cached.size} items)" }
                        ListDeliveryZonesOutput(zones = cached, fromCache = true)
                    } else {
                        // No hay cache -> propagar como excepcion del dominio.
                        throw networkError.toDoListDeliveryZonesException()
                    }
                }
        } catch (e: Exception) {
            logger.error(e) { "DoListDeliveryZones fallo de forma irrecuperable" }
            Result.failure(e.toDoListDeliveryZonesException())
        }
    }
}
