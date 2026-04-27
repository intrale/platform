package asdo.business.delivery

import ar.com.intrale.shared.business.DeliveryZoneDTO

/**
 * Resultado del caso de uso ToDoListDeliveryZones (split 1 #2420).
 *
 * - `zones`: la lista de zonas (ya ordenada por el caller — el use case no
 *   tiene opinion sobre orden, eso es responsabilidad del ViewModel).
 * - `fromCache`: true si la lista viene del cache local porque el backend
 *   fallo y habia datos guardados (CA-5-L). El UI muestra el banner offline
 *   y desactiva refresh agresivo cuando es true.
 */
data class ListDeliveryZonesOutput(
    val zones: List<DeliveryZoneDTO>,
    val fromCache: Boolean
)

/**
 * Caso de uso "listar zonas de delivery del negocio activo" — split 1 read-only de #2420.
 *
 * El service detras es solo GET (CA-5-L). Las mutaciones (POST/PUT/DELETE) llegan
 * en split 2 (#2421) con use cases separados.
 */
interface ToDoListDeliveryZones {
    suspend fun execute(businessId: String): Result<ListDeliveryZonesOutput>
}
