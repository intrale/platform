package ar.com.intrale.shared.client

import kotlinx.serialization.Serializable

/**
 * DTO de coordenada usada por los polígonos de zona (issue #2423).
 * Mantiene los nombres `lat` / `lng` que serializa el backend (#2415).
 */
@Serializable
data class LatLngDTO(
    val lat: Double = 0.0,
    val lng: Double = 0.0,
)

/**
 * Bounding box plano emitido por el backend en `/{business}/zones`.
 * El backend lo manda vacío (`{}`) cuando no hay zonas; la capa
 * cliente lo reinterpreta como `null` en `BusinessZoneSanitizer`.
 */
@Serializable
data class ZoneBoundingBoxDTO(
    val minLat: Double = 0.0,
    val maxLat: Double = 0.0,
    val minLng: Double = 0.0,
    val maxLng: Double = 0.0,
)

/**
 * Tipos de zona soportados por el backend (#2415 / `ZonesFunction`).
 */
object BusinessZoneTypeDTO {
    const val POLYGON = "POLYGON"
    const val CIRCLE = "CIRCLE"
}

/**
 * DTO crudo recibido del endpoint público `GET /{business}/zones`.
 * Las restricciones (rangos, whitelist de nombres) se aplican en
 * `asdo.client.BusinessZoneSanitizer` antes de exponer el modelo de UI.
 */
@Serializable
data class BusinessZoneDTO(
    val businessId: String = "",
    val zoneId: String = "",
    val type: String = BusinessZoneTypeDTO.POLYGON,
    val shippingCost: Double = 0.0,
    val estimatedTimeMinutes: Int = 0,
    val currency: String = "ARS",
    val name: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val boundingBox: ZoneBoundingBoxDTO? = null,
    /** Solo para zonas tipo POLYGON. */
    val polygon: List<LatLngDTO>? = null,
    /** Solo para zonas tipo CIRCLE. */
    val centerLat: Double? = null,
    val centerLng: Double? = null,
    val radiusMeters: Double? = null,
)

/**
 * Respuesta del backend para `GET /{business}/zones`.
 * El bounding box global es la unión de los bounding boxes de cada zona.
 */
@Serializable
data class ListBusinessZonesResponse(
    val zones: List<BusinessZoneDTO> = emptyList(),
    val globalBoundingBox: ZoneBoundingBoxDTO? = null,
)
