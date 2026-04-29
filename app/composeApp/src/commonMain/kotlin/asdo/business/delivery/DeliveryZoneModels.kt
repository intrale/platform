package asdo.business.delivery

/**
 * Modelos compartidos para el editor de zonas de entrega circulares (#2447).
 *
 * NOTA: Estos modelos son un STUB temporal hasta que aterrice la capa de datos
 * real entregada por #2446. Cuando #2446 mergee, los modelos definitivos vivirán
 * acá o serán re-exportados desde el módulo `:shared`.
 *
 * El contrato `ToDoSaveDeliveryZone` se mantiene estable: recibe un
 * `DeliveryZoneDraft` y devuelve `Result<DeliveryZone>`.
 */

/** Coordenada lat/lng. Lat ∈ [-90, 90], Lng ∈ [-180, 180]. */
data class Coordinate(
    val latitude: Double,
    val longitude: Double,
) {
    init {
        require(latitude in -90.0..90.0) { "latitude fuera de rango" }
        require(longitude in -180.0..180.0) { "longitude fuera de rango" }
    }
}

/** Tope cliente de zonas por negocio (CA-14). El servidor también enforce. */
const val MAX_DELIVERY_ZONES_PER_BUSINESS: Int = 10

/** Radio mínimo permitido en metros (CA-5). */
const val MIN_ZONE_RADIUS_METERS: Int = 50

/** Radio máximo permitido en metros. */
const val MAX_ZONE_RADIUS_METERS: Int = 20_000

/** Costo máximo en centavos = 10.000.000 ARS (CA-8). */
const val MAX_ZONE_COST_CENTS: Long = 1_000_000_000L

/** Largo máximo del nombre de zona en chars (CA-7). */
const val MAX_ZONE_NAME_LENGTH: Int = 80

/** Whitelist de caracteres permitidos en el nombre (CA-7, recomendación Security A03). */
private val NAME_WHITELIST_REGEX = Regex("^[\\p{L}\\p{N} \\-'.]{1,$MAX_ZONE_NAME_LENGTH}$")

/** Detecta caracteres de control / zero-width. */
private val CONTROL_OR_ZERO_WIDTH_REGEX = Regex("[\\p{Cc}\\u200B-\\u200D\\uFEFF]")

/** Detecta entidades HTML básicas (`&lt;`, `&#123;`). */
private val HTML_ENTITY_REGEX = Regex("&(?:[a-zA-Z]+|#[0-9]+);")

/** Sanitiza y valida el nombre. Devuelve null si es inválido. */
fun sanitizeZoneName(raw: String): String? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return null
    if (CONTROL_OR_ZERO_WIDTH_REGEX.containsMatchIn(trimmed)) return null
    if (HTML_ENTITY_REGEX.containsMatchIn(trimmed)) return null
    if (!NAME_WHITELIST_REGEX.matches(trimmed)) return null
    return trimmed
}

/** Borrador de zona enviado al ToDo de save. */
data class DeliveryZoneDraft(
    val businessId: String,
    val name: String,
    val center: Coordinate,
    val radiusMeters: Int,
    val costCents: Long,
    val estimatedMinutes: Int,
)

/** Zona persistida tal como la devuelve el backend. */
data class DeliveryZone(
    val id: String,
    val businessId: String,
    val name: String,
    val center: Coordinate,
    val radiusMeters: Int,
    val costCents: Long,
    val estimatedMinutes: Int,
)
