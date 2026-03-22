package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import com.google.gson.Gson
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

data class DeliveryZoneRecord(
    val type: String = "RADIUS",
    val radiusKm: Double = 0.0,
    val postalCodes: List<String> = emptyList()
)

class BusinessDeliveryZoneResponse(
    val deliveryZone: Map<String, Any> = emptyMap(),
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

class BusinessDeliveryZoneFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableBusiness: DynamoDbTable<Business>,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    private val gson = Gson()

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando business/delivery-zone para negocio=$business")

        requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN
        ) ?: return UnauthorizedException()

        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()

        return when (method) {
            HttpMethod.Get.value.uppercase() -> handleGet(business)
            HttpMethod.Put.value.uppercase() -> handlePut(business, textBody)
            else -> RequestValidationException("Metodo no soportado: $method")
        }
    }

    private fun handleGet(business: String): Response {
        val key = Business().apply { name = business }
        val existing = tableBusiness.getItem(key)
        val zone = deserializeZone(existing?.deliveryZoneJson)
        logger.debug("Retornando zona de entrega para negocio=$business")
        return buildResponse(business, zone)
    }

    private fun handlePut(business: String, textBody: String): Response {
        val body = parseBody<UpdateDeliveryZoneRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (!listOf("RADIUS", "POSTAL_CODES").contains(body.type)) {
            return RequestValidationException("Tipo de zona invalido. Use RADIUS o POSTAL_CODES")
        }
        if (body.type == "RADIUS" && body.radiusKm <= 0.0) {
            return RequestValidationException("El radio de entrega debe ser mayor a 0")
        }
        if (body.type == "POSTAL_CODES" && body.postalCodes.isEmpty()) {
            return RequestValidationException("Debe indicar al menos un codigo postal")
        }

        val key = Business().apply { name = business }
        val existing = tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado")

        val zone = DeliveryZoneRecord(
            type = body.type,
            radiusKm = body.radiusKm,
            postalCodes = body.postalCodes
        )
        existing.deliveryZoneJson = gson.toJson(zone)
        tableBusiness.updateItem(existing)

        logger.debug("Zona de entrega actualizada para negocio=$business")
        return buildResponse(business, zone, HttpStatusCode.OK)
    }

    private fun deserializeZone(json: String?): DeliveryZoneRecord {
        if (json.isNullOrBlank()) return DeliveryZoneRecord()
        return try {
            gson.fromJson(json, DeliveryZoneRecord::class.java) ?: DeliveryZoneRecord()
        } catch (e: Exception) {
            logger.error("Error deserializando zona de entrega", e)
            DeliveryZoneRecord()
        }
    }

    private fun buildResponse(
        business: String,
        zone: DeliveryZoneRecord,
        status: HttpStatusCode = HttpStatusCode.OK
    ): BusinessDeliveryZoneResponse {
        val zoneMap = mapOf(
            "businessId" to business,
            "type" to zone.type,
            "radiusKm" to zone.radiusKm,
            "postalCodes" to zone.postalCodes
        )
        return BusinessDeliveryZoneResponse(deliveryZone = zoneMap, status = status)
    }
}

data class UpdateDeliveryZoneRequest(
    val type: String = "RADIUS",
    val radiusKm: Double = 0.0,
    val postalCodes: List<String> = emptyList()
)
