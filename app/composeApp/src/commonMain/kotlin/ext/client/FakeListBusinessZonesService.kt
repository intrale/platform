package ext.client

import ar.com.intrale.shared.client.BusinessZoneDTO
import ar.com.intrale.shared.client.BusinessZoneTypeDTO
import ar.com.intrale.shared.client.LatLngDTO
import ar.com.intrale.shared.client.ListBusinessZonesResponse
import ar.com.intrale.shared.client.ZoneBoundingBoxDTO

/**
 * Fake del service publico de zonas para tests + dev mientras el backend
 * #2415 esta en flight (issue #2423 CA-11).
 *
 * Replica el contrato real (`ListBusinessZonesResponse`) sin tocar HTTP.
 * Las coordenadas son del centro de Buenos Aires por defecto, pero el
 * builder permite pasar zonas custom para testear estados (vacio, error,
 * coords fuera de rango, nombres invalidos).
 */
class FakeListBusinessZonesService(
    private val response: () -> Result<ListBusinessZonesResponse> = { Result.success(defaultPolygonZones()) },
) : CommListBusinessZonesService {

    override suspend fun listZones(businessId: String): Result<ListBusinessZonesResponse> = response()

    companion object {
        /** Dos zonas tipo POLYGON con costos distintos en CABA. */
        fun defaultPolygonZones(): ListBusinessZonesResponse = ListBusinessZonesResponse(
            zones = listOf(
                BusinessZoneDTO(
                    businessId = "intrale",
                    zoneId = "zone-norte",
                    type = BusinessZoneTypeDTO.POLYGON,
                    shippingCost = 500.0,
                    estimatedTimeMinutes = 30,
                    currency = "ARS",
                    name = "Zona Norte",
                    polygon = listOf(
                        LatLngDTO(lat = -34.5500, lng = -58.4700),
                        LatLngDTO(lat = -34.5500, lng = -58.4400),
                        LatLngDTO(lat = -34.5800, lng = -58.4400),
                        LatLngDTO(lat = -34.5800, lng = -58.4700),
                    ),
                    boundingBox = ZoneBoundingBoxDTO(
                        minLat = -34.5800, maxLat = -34.5500,
                        minLng = -58.4700, maxLng = -58.4400,
                    ),
                ),
                BusinessZoneDTO(
                    businessId = "intrale",
                    zoneId = "zone-centro",
                    type = BusinessZoneTypeDTO.POLYGON,
                    shippingCost = 300.0,
                    estimatedTimeMinutes = 20,
                    currency = "ARS",
                    name = "Zona Centro",
                    polygon = listOf(
                        LatLngDTO(lat = -34.6000, lng = -58.3900),
                        LatLngDTO(lat = -34.6000, lng = -58.3700),
                        LatLngDTO(lat = -34.6200, lng = -58.3700),
                        LatLngDTO(lat = -34.6200, lng = -58.3900),
                    ),
                    boundingBox = ZoneBoundingBoxDTO(
                        minLat = -34.6200, maxLat = -34.6000,
                        minLng = -58.3900, maxLng = -58.3700,
                    ),
                ),
            ),
            globalBoundingBox = ZoneBoundingBoxDTO(
                minLat = -34.6200, maxLat = -34.5500,
                minLng = -58.4700, maxLng = -58.3700,
            ),
        )

        fun emptyZones(): ListBusinessZonesResponse = ListBusinessZonesResponse(zones = emptyList())
    }
}
