package ar.com.intrale

import ar.com.intrale.geo.BoundingBox
import ar.com.intrale.geo.PointInPolygon
import ar.com.intrale.geo.Vertex
import ar.com.intrale.geo.round6
import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.model.QueryConditional
import java.security.SecureRandom
import java.time.Instant

/**
 * Funcion que maneja CRUD de zonas de delivery por negocio.
 *
 * - GET /{business}/zones        → publica (no requiere JWT)
 * - POST /{business}/zones       → segurizada (BUSINESS_ADMIN del business)
 * - DELETE /{business}/zones     → segurizada (zoneId via header X-Zone-Id)
 *
 * Como el dispatcher dinamico usa funcionKey de hasta 2 segmentos, el
 * `zoneId` para DELETE viaja por el header `X-Zone-Id` (decision documentada
 * en CA-14 — el dispatcher actual no soporta `/{business}/zones/{zoneId}`
 * sin modificar Application.kt).
 *
 * GET es publico por diseno (#2415 CA-3): los clientes finales necesitan
 * conocer las zonas de cobertura.
 */
class ZonesFunction(
    val config: UsersConfig,
    val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableZones: DynamoDbTable<DeliveryZoneEntity>,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    private val jwtValidator: JwtValidator = CognitoJwtValidator(config),
    private val zoneIdGenerator: () -> String = { generateZoneId() },
    private val clock: () -> Instant = Instant::now,
) : Function {

    private val gson = Gson()

    override suspend fun execute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String,
    ): Response {
        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()

        return when (method) {
            HttpMethod.Get.value.uppercase() -> handleGet(business)
            HttpMethod.Post.value.uppercase() -> handleAuthenticated(business, headers) {
                handlePost(business, textBody)
            }
            HttpMethod.Delete.value.uppercase() -> handleAuthenticated(business, headers) {
                handleDelete(business, headers)
            }
            else -> RequestValidationException("Metodo no soportado: $method")
        }
    }

    private suspend fun handleAuthenticated(
        business: String,
        headers: Map<String, String>,
        block: suspend () -> Response,
    ): Response {
        val token = headers["Authorization"]
        try {
            jwtValidator.validate(token ?: throw IllegalArgumentException("Token faltante"))
        } catch (e: Exception) {
            logger.warn("Token invalido: ${e.message}")
            return UnauthorizedException()
        }
        // Cross-tenant check: el perfil del usuario debe estar APPROVED para `business`.
        val approved = requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN
        )
        if (approved == null) {
            logger.warn(
                "Intento cross-tenant rechazado: urlBusiness=$business, accion=zones, " +
                    "email=${headers["X-Caller-Email"] ?: "(desconocido)"}"
            )
            return UnauthorizedException()
        }
        return block()
    }

    // ----------------------------------------------------------- GET /zones
    private fun handleGet(business: String): Response {
        val items = queryZones(business)
        val zones = items.map { it.toMap() }
        val globalBb = if (items.isEmpty()) null else items
            .mapNotNull { deserializeBoundingBox(it.boundingBoxJson) }
            .reduceOrNull { acc, bb -> acc.expand(bb) }
        return ZonesListResponse(
            zones = zones,
            globalBoundingBox = globalBb?.let {
                mapOf(
                    "minLat" to it.minLat,
                    "maxLat" to it.maxLat,
                    "minLng" to it.minLng,
                    "maxLng" to it.maxLng,
                )
            } ?: emptyMap(),
        )
    }

    // ---------------------------------------------------------- POST /zones
    private fun handlePost(business: String, textBody: String): Response {
        val request = parseBody<CreateZoneRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        val validationError = validateCreateZoneRequest(request)
        if (validationError != null) return validationError

        val existingCount = queryZones(business).size
        if (existingCount >= MAX_ZONES_PER_BUSINESS) {
            return RequestValidationException(
                "Limite de $MAX_ZONES_PER_BUSINESS zonas por negocio alcanzado"
            )
        }

        val now = clock().toString()
        val newZone = DeliveryZoneEntity().apply {
            this.businessId = business
            this.zoneId = zoneIdGenerator()
            this.type = request.type
            this.shippingCost = request.shippingCost
            this.estimatedTimeMinutes = request.estimatedTimeMinutes
            this.name = request.name
            this.currency = request.currency ?: DEFAULT_CURRENCY
            this.createdAt = now
            this.updatedAt = now
            when (request.type) {
                TYPE_POLYGON -> {
                    val truncated = request.polygon!!.map { Vertex(it.lat, it.lng).truncated() }
                    this.coordsJson = gson.toJson(truncated.map { mapOf("lat" to it.lat, "lng" to it.lng) })
                    this.boundingBoxJson = gson.toJson(BoundingBox.ofPolygon(truncated).toMap())
                }
                TYPE_CIRCLE -> {
                    val cLat = round6(request.centerLat!!)
                    val cLng = round6(request.centerLng!!)
                    val rMeters = request.radiusMeters!!
                    this.centerLat = cLat
                    this.centerLng = cLng
                    this.radiusMeters = rMeters
                    this.boundingBoxJson = gson.toJson(BoundingBox.ofCircle(cLat, cLng, rMeters).toMap())
                }
            }
        }

        tableZones.putItem(newZone)
        logger.info("zona creada: business=$business, zoneId=${newZone.zoneId}, type=${newZone.type}")
        return ZoneCreatedResponse(zoneId = newZone.zoneId!!, zone = newZone.toMap())
    }

    // -------------------------------------------------------- DELETE /zones
    private fun handleDelete(business: String, headers: Map<String, String>): Response {
        val zoneId = headers["X-Zone-Id"]?.takeIf { it.isNotBlank() }
            ?: return RequestValidationException("Header X-Zone-Id requerido para eliminar una zona")

        // Verificar que pertenece al business (anti-cross-tenant en el delete)
        val key = Key.builder().partitionValue(business).sortValue(zoneId).build()
        val existing = tableZones.getItem(key)
        if (existing == null || existing.businessId != business) {
            logger.warn(
                "Intento de borrado de zona inexistente o cross-tenant: " +
                    "urlBusiness=$business, zoneId=$zoneId"
            )
            return ExceptionResponse("Zona no encontrada", HttpStatusCode.NotFound)
        }

        tableZones.deleteItem(key)
        logger.info("zona eliminada: business=$business, zoneId=$zoneId")
        return Response(statusCode = HttpStatusCode.OK)
    }

    // ------------------------------------------------------------- Helpers
    private fun queryZones(business: String): List<DeliveryZoneEntity> = try {
        val cond = QueryConditional.keyEqualTo(Key.builder().partitionValue(business).build())
        tableZones.query(cond)
            .stream()
            .toList()
            .flatMap { it.items() }
    } catch (e: Exception) {
        logger.error("Error consultando zonas para business=$business", e)
        emptyList()
    }

    private fun deserializeBoundingBox(json: String?): BoundingBox? {
        if (json.isNullOrBlank()) return null
        return try {
            val map: Map<String, Double> =
                gson.fromJson(json, object : TypeToken<Map<String, Double>>() {}.type)
            BoundingBox(
                minLat = map["minLat"] ?: return null,
                maxLat = map["maxLat"] ?: return null,
                minLng = map["minLng"] ?: return null,
                maxLng = map["maxLng"] ?: return null,
            )
        } catch (e: Exception) {
            logger.error("Error deserializando boundingBoxJson: ${e.message}")
            null
        }
    }

    companion object {
        const val TYPE_POLYGON = "POLYGON"
        const val TYPE_CIRCLE = "CIRCLE"
        const val MAX_ZONES_PER_BUSINESS = 50
        const val MIN_VERTICES = 3
        const val MAX_VERTICES = 1000
        const val MAX_SHIPPING_COST = 100_000.0
        const val MIN_SHIPPING_COST = 0.0
        const val MAX_ZONE_NAME_LENGTH = 40
        const val DEFAULT_CURRENCY = "ARS"
        const val MIN_POLYGON_AREA_DEG2 = 1e-9
        private const val ZONE_ID_PREFIX = "zn_"
        private const val ZONE_ID_BODY_LENGTH = 12
        private const val BASE36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

        fun generateZoneId(): String {
            val random = SecureRandom()
            val sb = StringBuilder(ZONE_ID_PREFIX)
            repeat(ZONE_ID_BODY_LENGTH) {
                sb.append(BASE36_ALPHABET[random.nextInt(BASE36_ALPHABET.length)])
            }
            return sb.toString()
        }

        fun validateCreateZoneRequest(request: CreateZoneRequest): Response? {
            // Tipo
            if (request.type != TYPE_POLYGON && request.type != TYPE_CIRCLE) {
                return RequestValidationException("El tipo de zona debe ser POLYGON o CIRCLE")
            }
            // Costo
            if (request.shippingCost < MIN_SHIPPING_COST) {
                return RequestValidationException("El costo de envio no puede ser negativo")
            }
            if (request.shippingCost > MAX_SHIPPING_COST) {
                return RequestValidationException(
                    "El costo de envio supera el maximo permitido (${MAX_SHIPPING_COST.toInt()})"
                )
            }
            if (request.estimatedTimeMinutes < 0) {
                return RequestValidationException("El tiempo estimado no puede ser negativo")
            }
            // Nombre opcional
            request.name?.let {
                if (it.length > MAX_ZONE_NAME_LENGTH) {
                    return RequestValidationException(
                        "El nombre de la zona supera el maximo de $MAX_ZONE_NAME_LENGTH caracteres"
                    )
                }
                if (!it.matches(Regex("^[A-Za-z0-9 _.\\-]+$"))) {
                    return RequestValidationException(
                        "El nombre de la zona contiene caracteres no permitidos"
                    )
                }
            }
            // Validacion por tipo
            when (request.type) {
                TYPE_POLYGON -> {
                    val polygon = request.polygon
                        ?: return RequestValidationException(
                            "El campo polygon es requerido para zonas tipo POLYGON"
                        )
                    if (polygon.size < MIN_VERTICES) {
                        return RequestValidationException(
                            "El poligono debe tener al menos $MIN_VERTICES vertices"
                        )
                    }
                    if (polygon.size > MAX_VERTICES) {
                        return RequestValidationException(
                            "El poligono tiene demasiados vertices (maximo $MAX_VERTICES)"
                        )
                    }
                    for (vertex in polygon) {
                        if (vertex.lat !in -90.0..90.0) {
                            return RequestValidationException(
                                "La latitud debe estar entre -90 y 90 grados"
                            )
                        }
                        if (vertex.lng !in -180.0..180.0) {
                            return RequestValidationException(
                                "La longitud debe estar entre -180 y 180 grados"
                            )
                        }
                    }
                    val vertices = polygon.map { Vertex(it.lat, it.lng) }
                    // Verificamos auto-interseccion primero porque algunos
                    // bowties simetricos tienen shoelace area = 0 (las dos
                    // mitades se cancelan).
                    if (PointInPolygon.isSelfIntersecting(vertices)) {
                        return RequestValidationException(
                            "El poligono no puede cruzarse consigo mismo"
                        )
                    }
                    if (PointInPolygon.absoluteShoelaceArea(vertices) < MIN_POLYGON_AREA_DEG2) {
                        return RequestValidationException(
                            "El poligono es demasiado chico o los puntos estan alineados"
                        )
                    }
                }
                TYPE_CIRCLE -> {
                    val cLat = request.centerLat
                    val cLng = request.centerLng
                    val rMeters = request.radiusMeters
                    if (cLat == null || cLng == null || rMeters == null) {
                        return RequestValidationException(
                            "Los campos centerLat, centerLng y radiusMeters son requeridos para zonas tipo CIRCLE"
                        )
                    }
                    if (cLat !in -90.0..90.0) {
                        return RequestValidationException(
                            "La latitud debe estar entre -90 y 90 grados"
                        )
                    }
                    if (cLng !in -180.0..180.0) {
                        return RequestValidationException(
                            "La longitud debe estar entre -180 y 180 grados"
                        )
                    }
                    if (rMeters <= 0) {
                        return RequestValidationException(
                            "El radio debe ser mayor a 0 metros"
                        )
                    }
                    if (rMeters > 200_000.0) {
                        return RequestValidationException(
                            "El radio supera el maximo permitido (200000 metros)"
                        )
                    }
                }
            }
            return null
        }
    }
}

// --------------------------------------------------------------- DTOs
data class VertexDto(
    val lat: Double = 0.0,
    val lng: Double = 0.0,
)

data class CreateZoneRequest(
    val type: String = "",
    val shippingCost: Double = 0.0,
    val estimatedTimeMinutes: Int = 0,
    val name: String? = null,
    val currency: String? = null,
    /** Solo para POLYGON */
    val polygon: List<VertexDto>? = null,
    /** Solo para CIRCLE */
    val centerLat: Double? = null,
    val centerLng: Double? = null,
    val radiusMeters: Double? = null,
)

class ZonesListResponse(
    val zones: List<Map<String, Any?>> = emptyList(),
    val globalBoundingBox: Map<String, Double> = emptyMap(),
    status: HttpStatusCode = HttpStatusCode.OK,
) : Response(statusCode = status)

class ZoneCreatedResponse(
    val zoneId: String = "",
    val zone: Map<String, Any?> = emptyMap(),
    status: HttpStatusCode = HttpStatusCode.OK,
) : Response(statusCode = status)

internal fun BoundingBox.toMap(): Map<String, Double> = mapOf(
    "minLat" to minLat,
    "maxLat" to maxLat,
    "minLng" to minLng,
    "maxLng" to maxLng,
)

internal fun DeliveryZoneEntity.toMap(): Map<String, Any?> {
    val gson = Gson()
    val coordsType = object : TypeToken<List<Map<String, Double>>>() {}.type
    val coords: List<Map<String, Double>> = if (coordsJson.isNullOrBlank()) {
        emptyList()
    } else {
        try {
            gson.fromJson(coordsJson, coordsType) ?: emptyList()
        } catch (e: Exception) {
            emptyList()
        }
    }
    val bbType = object : TypeToken<Map<String, Double>>() {}.type
    val bb: Map<String, Double> = if (boundingBoxJson.isNullOrBlank()) {
        emptyMap()
    } else {
        try {
            gson.fromJson(boundingBoxJson, bbType) ?: emptyMap()
        } catch (e: Exception) {
            emptyMap()
        }
    }
    val map = mutableMapOf<String, Any?>(
        "businessId" to businessId,
        "zoneId" to zoneId,
        "type" to type,
        "shippingCost" to shippingCost,
        "estimatedTimeMinutes" to estimatedTimeMinutes,
        "currency" to (currency ?: ZonesFunction.DEFAULT_CURRENCY),
        "boundingBox" to bb,
        "name" to name,
        "createdAt" to createdAt,
        "updatedAt" to updatedAt,
    )
    if (type == ZonesFunction.TYPE_POLYGON) {
        map["polygon"] = coords
    } else if (type == ZonesFunction.TYPE_CIRCLE) {
        map["centerLat"] = centerLat
        map["centerLng"] = centerLng
        map["radiusMeters"] = radiusMeters
    }
    return map
}
