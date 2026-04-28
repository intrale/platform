package asdo.client

import ext.client.CommListBusinessZonesService
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

/**
 * Implementacion de [ToDoListBusinessZones].
 *
 * Patron de error estandar (#2423 CA-6):
 * - `runCatching` envolviendo la llamada al service.
 * - `mapCatching` para transformar la respuesta cruda en
 *   [DoListBusinessZonesResult] saneado.
 * - `recoverCatching` para mapear cualquier excepcion al tipo
 *   [DoListBusinessZonesException] (mas util para la UI).
 *
 * Sin logs con coordenadas / direcciones / lat / lng (Security A09).
 * Solo se logguea el `businessId` (no es PII en el contexto del cliente).
 */
class DoListBusinessZones(
    private val service: CommListBusinessZonesService,
) : ToDoListBusinessZones {

    private val logger = LoggerFactory.default.newLogger<DoListBusinessZones>()

    override suspend fun execute(businessId: String): Result<DoListBusinessZonesResult> = runCatching {
        logger.info { "Consultando zonas publicas para businessId=$businessId" }
        val response = service.listZones(businessId).getOrThrow()

        val sanitizedZones = BusinessZoneSanitizer.sanitizeAll(response.zones)
        // El bounding box puede venir del backend (globalBoundingBox) o calcularse
        // localmente con BoundingBoxCalculator. Preferimos el local para no
        // depender de un campo opcional del backend (#2423 CA-2).
        val computedBox = BoundingBoxCalculator.compute(sanitizedZones)
            ?: BusinessZoneSanitizer.sanitizeBoundingBox(response.globalBoundingBox)

        DoListBusinessZonesResult(
            zones = sanitizedZones,
            boundingBox = computedBox,
        )
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo listando zonas publicas para businessId=$businessId" }
        throw throwable.toDoListBusinessZonesException()
    }
}
