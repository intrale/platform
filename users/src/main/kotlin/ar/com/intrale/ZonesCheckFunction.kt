package ar.com.intrale

import ar.com.intrale.geo.BoundingBox
import ar.com.intrale.geo.TokenBucketRateLimiter
import ar.com.intrale.geo.Vertex
import ar.com.intrale.geo.ZoneGeometry
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.model.QueryConditional

/**
 * Endpoint publico para verificar si un punto cae dentro de alguna zona del
 * negocio. Aplica rate limit por IP (10 req/s, ver CA-9).
 *
 * El `shippingCost` devuelto es la fuente autoritativa (CA-8): el flujo de
 * checkout debe re-verificar contra este endpoint y NO confiar en el costo
 * que mande el cliente.
 *
 * Mitigaciones de seguridad:
 *  - Rate limit token-bucket por IP (CA-9, A04)
 *  - IP real desde el ULTIMO valor de X-Forwarded-For (no spoofeable por
 *    cliente; el ultimo salto lo agrega API Gateway)
 *  - Respuesta minimal cuando inZone=false (no revela zonas cercanas — A04)
 *  - Sin PII: NO loggea lat/lng del usuario final (CA-11)
 */
class ZonesCheckFunction(
    val config: UsersConfig,
    val logger: Logger,
    private val tableZones: DynamoDbTable<DeliveryZoneEntity>,
    private val rateLimiter: TokenBucketRateLimiter = TokenBucketRateLimiter(
        capacity = DEFAULT_RATE_CAPACITY,
        refillPerSecond = DEFAULT_RATE_REFILL_PER_SECOND,
    ),
) : Function {

    private val gson = Gson()

    override suspend fun execute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String,
    ): Response {
        val ip = resolveClientIp(headers)
        if (!rateLimiter.tryAcquire(ip)) {
            logger.warn("Rate limit exceeded: ip=$ip, endpoint=/zones/check")
            return RateLimitedResponse()
        }

        val request = parseBody<ZoneCheckRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (request.lat !in -90.0..90.0) {
            return RequestValidationException("La latitud debe estar entre -90 y 90 grados")
        }
        if (request.lng !in -180.0..180.0) {
            return RequestValidationException("La longitud debe estar entre -180 y 180 grados")
        }

        val point = Vertex(request.lat, request.lng)
        val zones = queryZones(business)

        if (zones.isEmpty()) {
            logger.info("zones/check: business=$business, inZone=false, reason=NO_ZONES_DEFINED")
            return ZoneCheckResponse(inZone = false, reason = REASON_NO_ZONES_DEFINED)
        }

        // Filtro por bounding box, luego ray casting / haversine.
        for (zone in zones) {
            val bb = deserializeBoundingBox(zone.boundingBoxJson)
            if (bb != null && !bb.contains(point)) continue
            val matches = when (zone.type) {
                ZonesFunction.TYPE_POLYGON -> {
                    val polygon = deserializePolygon(zone.coordsJson)
                    polygon.size >= 3 && ZoneGeometry.isPointInPolygon(polygon, point)
                }
                ZonesFunction.TYPE_CIRCLE -> {
                    val cLat = zone.centerLat
                    val cLng = zone.centerLng
                    val rMeters = zone.radiusMeters
                    if (cLat != null && cLng != null && rMeters != null) {
                        ZoneGeometry.isPointInCircle(cLat, cLng, rMeters, point)
                    } else false
                }
                else -> false
            }
            if (matches) {
                logger.info("zones/check: business=$business, inZone=true, zoneId=${zone.zoneId}")
                return ZoneCheckResponse(
                    inZone = true,
                    shippingCost = zone.shippingCost,
                    estimatedTimeMinutes = zone.estimatedTimeMinutes,
                    zoneId = zone.zoneId,
                    currency = zone.currency ?: ZonesFunction.DEFAULT_CURRENCY,
                )
            }
        }

        logger.info("zones/check: business=$business, inZone=false, reason=OUT_OF_COVERAGE")
        return ZoneCheckResponse(inZone = false, reason = REASON_OUT_OF_COVERAGE)
    }

    private fun queryZones(business: String): List<DeliveryZoneEntity> = try {
        val cond = QueryConditional.keyEqualTo(Key.builder().partitionValue(business).build())
        tableZones.query(cond).stream().toList().flatMap { it.items() }
    } catch (e: Exception) {
        logger.error("Error consultando zonas para business=$business", e)
        emptyList()
    }

    private fun deserializePolygon(json: String?): List<Vertex> {
        if (json.isNullOrBlank()) return emptyList()
        return try {
            val type = object : TypeToken<List<Map<String, Double>>>() {}.type
            val raw: List<Map<String, Double>> = gson.fromJson(json, type) ?: emptyList()
            raw.mapNotNull { m ->
                val lat = m["lat"] ?: return@mapNotNull null
                val lng = m["lng"] ?: return@mapNotNull null
                Vertex(lat, lng)
            }
        } catch (e: Exception) {
            logger.error("Error deserializando coordsJson: ${e.message}")
            emptyList()
        }
    }

    private fun deserializeBoundingBox(json: String?): BoundingBox? {
        if (json.isNullOrBlank()) return null
        return try {
            val type = object : TypeToken<Map<String, Double>>() {}.type
            val map: Map<String, Double> = gson.fromJson(json, type) ?: return null
            BoundingBox(
                minLat = map["minLat"] ?: return null,
                maxLat = map["maxLat"] ?: return null,
                minLng = map["minLng"] ?: return null,
                maxLng = map["maxLng"] ?: return null,
            )
        } catch (e: Exception) {
            null
        }
    }

    companion object {
        const val DEFAULT_RATE_CAPACITY = 10
        const val DEFAULT_RATE_REFILL_PER_SECOND = 10.0
        const val REASON_NO_ZONES_DEFINED = "NO_ZONES_DEFINED"
        const val REASON_OUT_OF_COVERAGE = "OUT_OF_COVERAGE"

        /**
         * Devuelve la IP real del cliente desde X-Forwarded-For tomando el
         * ULTIMO valor (el primero es spoofeable por el cliente; el ultimo lo
         * agrega API Gateway). Si no hay XFF, intenta cabeceras alternativas.
         */
        fun resolveClientIp(headers: Map<String, String>): String {
            val xff = headers["X-Forwarded-For"] ?: headers["x-forwarded-for"]
            if (!xff.isNullOrBlank()) {
                return xff.split(",").map { it.trim() }.lastOrNull { it.isNotEmpty() }
                    ?: "unknown"
            }
            return headers["X-Real-IP"]
                ?: headers["x-real-ip"]
                ?: "unknown"
        }
    }
}

data class ZoneCheckRequest(
    val lat: Double = 0.0,
    val lng: Double = 0.0,
)

class ZoneCheckResponse(
    val inZone: Boolean = false,
    val shippingCost: Double? = null,
    val estimatedTimeMinutes: Int? = null,
    val zoneId: String? = null,
    val currency: String? = null,
    val reason: String? = null,
    status: HttpStatusCode = HttpStatusCode.OK,
) : Response(statusCode = status)

class RateLimitedResponse(
    val message: String = "Rate limit excedido para este endpoint",
) : Response(statusCode = HttpStatusCode.TooManyRequests)
