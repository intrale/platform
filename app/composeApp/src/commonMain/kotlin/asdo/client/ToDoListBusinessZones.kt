package asdo.client

/**
 * Caso de uso: lista las zonas de cobertura publicas de un negocio.
 *
 * Fuente: GET /{business}/zones (issue #2415, endpoint publico, sin Bearer).
 *
 * El resultado ya viene saneado: coordenadas dentro de rango, costos no
 * negativos y nombres validados con la whitelist (ver
 * `BusinessZoneSanitizer`).
 *
 * Issue: #2423 — Hija B del split #2417.
 */
interface ToDoListBusinessZones {
    suspend fun execute(businessId: String): Result<DoListBusinessZonesResult>
}
