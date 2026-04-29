package ar.com.intrale

import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSortKey

/**
 * Entidad para zonas de delivery configurables (POLYGON | CIRCLE).
 *
 * Tabla: deliveryzones
 * - PK: businessId
 * - SK: zoneId  (primer uso de sort key compuesto en el proyecto)
 *
 * Esta entidad coexiste con `Business.deliveryZoneJson` (modelo legacy
 * RADIUS/POSTAL_CODES). La migracion del modelo viejo queda fuera de alcance
 * de la historia #2415.
 */
@DynamoDbBean
class DeliveryZoneEntity {

    @get:DynamoDbPartitionKey
    var businessId: String? = null

    @get:DynamoDbSortKey
    var zoneId: String? = null

    /** POLYGON | CIRCLE */
    var type: String? = null

    /** Lista de Vertex(lat,lng) serializada con kotlinx.serialization */
    var coordsJson: String? = null

    /** BoundingBox precomputado para optimizar el point-in-polygon */
    var boundingBoxJson: String? = null

    var shippingCost: Double = 0.0

    var estimatedTimeMinutes: Int = 0

    /** Solo para CIRCLE */
    var centerLat: Double? = null
    var centerLng: Double? = null
    var radiusMeters: Double? = null

    /** Nombre humano opcional (UX-7) */
    var name: String? = null

    /** Moneda autoritativa del shippingCost (UX-6) */
    var currency: String? = "ARS"

    var createdAt: String? = null
    var updatedAt: String? = null
}
