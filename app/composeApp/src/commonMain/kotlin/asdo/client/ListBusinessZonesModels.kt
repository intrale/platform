package asdo.client

import ar.com.intrale.shared.client.BusinessZoneDTO
import ar.com.intrale.shared.client.BusinessZoneTypeDTO
import ar.com.intrale.shared.client.LatLngDTO
import ar.com.intrale.shared.client.ZoneBoundingBoxDTO

/**
 * Resultado saneado para la pantalla de mapa de zonas (issue #2423).
 *
 * Contiene SOLO zonas válidas (lat/lng en rango, costo no negativo, nombre
 * dentro de la whitelist). El sanitizado se hace en `BusinessZoneSanitizer`
 * antes de exponer datos a la UI — la pantalla nunca recibe coordenadas
 * fuera de rango ni nombres con caracteres riesgosos.
 *
 * El bounding box global se recomputa en cliente con `BoundingBoxCalculator`
 * para no depender del que envía el backend (ya pueda estar vacío para
 * negocios sin zonas).
 */
data class DoListBusinessZonesResult(
    val zones: List<SanitizedBusinessZone> = emptyList(),
    val boundingBox: SanitizedBoundingBox? = null,
)

/** Zona ya saneada y lista para renderizarse. */
data class SanitizedBusinessZone(
    val zoneId: String,
    val name: String,
    val type: ZoneShape,
    val shippingCost: Double,
    val currency: String,
    val polygon: List<SanitizedLatLng> = emptyList(),
    val center: SanitizedLatLng? = null,
    val radiusMeters: Double? = null,
)

/** Coordenada saneada (siempre en rango -90..90 / -180..180). */
data class SanitizedLatLng(
    val lat: Double,
    val lng: Double,
)

/** Bounding box plano (recomputado en cliente). */
data class SanitizedBoundingBox(
    val minLat: Double,
    val maxLat: Double,
    val minLng: Double,
    val maxLng: Double,
)

/** Forma geométrica de la zona, derivada del campo `type` del backend. */
enum class ZoneShape { POLYGON, CIRCLE, UNKNOWN }

/**
 * Sanitizador de zonas crudas (`BusinessZoneDTO`) recibidas del backend.
 *
 * Reglas (Security A03/A09 + criterios PO):
 * - Coordenadas fuera de `lat in -90..90` o `lng in -180..180` se descartan.
 * - `shippingCost < 0` se descarta (el backend ya valida pero defendemos en cliente).
 * - Nombre con caracteres no permitidos cae a fallback `"Zona"`.
 * - Nombre con length > 40 se trunca a 40.
 * - Polígonos con menos de 3 vértices válidos se descartan.
 * - Círculos sin `centerLat/centerLng/radiusMeters > 0` válidos se descartan.
 *
 * Sin logs con coordenadas (Security A09) — solo `zoneId` cuando hay descarte.
 */
object BusinessZoneSanitizer {

    private const val MAX_NAME_LENGTH = 40
    private const val FALLBACK_NAME = "Zona"

    // Whitelist: letras (incluye Unicode), dígitos, espacio, guion medio,
    // punto y coma. Coincide con el espíritu del audit Security A03.
    private val NAME_WHITELIST = Regex("^[\\p{L}\\p{N} \\-.,]+$")

    fun sanitize(dto: BusinessZoneDTO): SanitizedBusinessZone? {
        val zoneId = dto.zoneId.takeIf { it.isNotBlank() } ?: return null
        if (dto.shippingCost < 0.0) return null

        val name = sanitizeName(dto.name)

        return when (dto.type) {
            BusinessZoneTypeDTO.POLYGON -> sanitizePolygon(dto, zoneId, name)
            BusinessZoneTypeDTO.CIRCLE -> sanitizeCircle(dto, zoneId, name)
            else -> null // tipos desconocidos se descartan
        }
    }

    fun sanitizeAll(zones: List<BusinessZoneDTO>): List<SanitizedBusinessZone> =
        zones.mapNotNull(::sanitize)

    fun sanitizeName(rawName: String?): String {
        val trimmed = rawName?.trim().orEmpty()
        if (trimmed.isEmpty()) return FALLBACK_NAME
        if (!NAME_WHITELIST.matches(trimmed)) return FALLBACK_NAME
        return if (trimmed.length > MAX_NAME_LENGTH) trimmed.substring(0, MAX_NAME_LENGTH) else trimmed
    }

    private fun sanitizePolygon(
        dto: BusinessZoneDTO,
        zoneId: String,
        name: String,
    ): SanitizedBusinessZone? {
        val rawPoints = dto.polygon ?: return null
        val validPoints = rawPoints.mapNotNull { it.toSanitized() }
        if (validPoints.size < MIN_POLYGON_VERTICES) return null
        return SanitizedBusinessZone(
            zoneId = zoneId,
            name = name,
            type = ZoneShape.POLYGON,
            shippingCost = dto.shippingCost,
            currency = dto.currency,
            polygon = validPoints,
        )
    }

    private fun sanitizeCircle(
        dto: BusinessZoneDTO,
        zoneId: String,
        name: String,
    ): SanitizedBusinessZone? {
        val cLat = dto.centerLat ?: return null
        val cLng = dto.centerLng ?: return null
        val rMeters = dto.radiusMeters ?: return null
        if (cLat !in LAT_RANGE || cLng !in LNG_RANGE) return null
        if (rMeters <= 0.0) return null
        return SanitizedBusinessZone(
            zoneId = zoneId,
            name = name,
            type = ZoneShape.CIRCLE,
            shippingCost = dto.shippingCost,
            currency = dto.currency,
            center = SanitizedLatLng(cLat, cLng),
            radiusMeters = rMeters,
        )
    }

    private fun LatLngDTO.toSanitized(): SanitizedLatLng? {
        if (lat !in LAT_RANGE) return null
        if (lng !in LNG_RANGE) return null
        return SanitizedLatLng(lat, lng)
    }

    fun sanitizeBoundingBox(raw: ZoneBoundingBoxDTO?): SanitizedBoundingBox? {
        if (raw == null) return null
        if (raw.minLat == 0.0 && raw.maxLat == 0.0 &&
            raw.minLng == 0.0 && raw.maxLng == 0.0
        ) {
            // Backend manda mapa vacío `{}` cuando no hay zonas; lo tratamos como null.
            return null
        }
        if (raw.minLat !in LAT_RANGE || raw.maxLat !in LAT_RANGE) return null
        if (raw.minLng !in LNG_RANGE || raw.maxLng !in LNG_RANGE) return null
        if (raw.minLat > raw.maxLat || raw.minLng > raw.maxLng) return null
        return SanitizedBoundingBox(
            minLat = raw.minLat,
            maxLat = raw.maxLat,
            minLng = raw.minLng,
            maxLng = raw.maxLng,
        )
    }

    internal val LAT_RANGE = -90.0..90.0
    internal val LNG_RANGE = -180.0..180.0
    internal const val MIN_POLYGON_VERTICES = 3
}

/**
 * Excepción específica del flujo (issue #2423) — envuelve cualquier error
 * de red / parsing y permite a la UI mostrar el estado error con retry.
 */
class DoListBusinessZonesException(
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)

internal fun Throwable.toDoListBusinessZonesException(): DoListBusinessZonesException =
    if (this is DoListBusinessZonesException) this
    else DoListBusinessZonesException(
        message = message ?: "Error al consultar zonas de cobertura",
        cause = this,
    )
