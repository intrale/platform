package ext.client

import ar.com.intrale.shared.client.ZoneCheckResponse

/**
 * Contrato para verificar si un par de coordenadas está dentro de la zona
 * de cobertura del negocio actual.
 *
 * Privacidad (CA-5 / CA-7):
 * - Las implementaciones NO deben loggear `latitude`/`longitude`.
 * - HTTPS obligatorio en `BuildKonfig.BASE_URL` del flavor `client` (CA-5).
 */
interface CommZoneCheckService {
    suspend fun checkZone(latitude: Double, longitude: Double): Result<ZoneCheckResponse>
}
