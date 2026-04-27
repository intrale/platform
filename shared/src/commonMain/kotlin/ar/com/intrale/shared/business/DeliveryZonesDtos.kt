package ar.com.intrale.shared.business

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

/**
 * Punto geografico (lat/lng) — usado por las zonas de delivery del split #2420.
 *
 * NO depende de Google Maps SDK (es commonMain) — el adapter a `LatLng` se hace
 * en androidMain/business cuando se renderea el polygon en GoogleMap.
 */
@Serializable
data class GeoPointDTO(
    val latitude: Double,
    val longitude: Double
)

/**
 * Zona de delivery dibujada como poligono sobre un mapa.
 *
 * - `id`: identificador estable, usado como key en LazyColumn y para correlacionar
 *   tap mapa <-> tap lista (CA-3-L de #2420).
 * - `name`: nombre dado por el dueno del negocio.
 * - `points`: vertices del poligono en orden. >= 3 puntos. El cierre (last == first)
 *   no es necesario; lo agrega el renderer si el estilo lo requiere.
 * - `costCents`: costo del envio en CENTAVOS de la moneda local (evita doubles para
 *   precios). Se formatea con PriceFormatter ($ 1.500) en la UI. 0 = "Gratis".
 * - `estimatedMinutes`: tiempo aproximado de entrega. null = ocultar el subtitulo
 *   (CA-3-L: "tiempo estimado si existe").
 *
 * El backend (#2415) define el shape exacto del payload. Esta DTO documenta el
 * contrato que el split 1 espera; si #2415 difiere, ajustar aca.
 */
@Serializable
data class DeliveryZoneDTO(
    val id: String,
    val name: String,
    val points: List<GeoPointDTO> = emptyList(),
    val costCents: Long = 0L,
    val estimatedMinutes: Int? = null
)

@Serializable
data class ListDeliveryZonesResponse(
    val statusCode: StatusCodeDTO,
    val zones: List<DeliveryZoneDTO> = emptyList()
)
