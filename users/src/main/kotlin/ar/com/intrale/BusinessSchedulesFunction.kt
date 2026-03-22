package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

data class DayScheduleRecord(
    val day: String = "",
    val isOpen: Boolean = false,
    val openTime: String = "00:00",
    val closeTime: String = "23:59"
)

data class BusinessSchedulesResponseBody(
    val statusCode: Map<String, Any>,
    val schedules: Map<String, Any>
)

class BusinessSchedulesResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val schedules: Map<String, Any> = emptyMap(),
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

class BusinessSchedulesFunction(
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
        logger.debug("Iniciando business/schedules para negocio=$business")

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
        val schedules = deserializeSchedules(existing?.schedulesJson)
        logger.debug("Retornando horarios para negocio=$business")
        return buildResponse(business, schedules)
    }

    private fun handlePut(business: String, textBody: String): Response {
        val body = parseBody<UpdateSchedulesRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (body.schedules.isEmpty()) {
            return RequestValidationException("Debe indicar al menos un horario")
        }

        val key = Business().apply { name = business }
        val existing = tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado")

        existing.schedulesJson = gson.toJson(body.schedules)
        tableBusiness.updateItem(existing)

        logger.debug("Horarios actualizados para negocio=$business")
        return buildResponse(business, body.schedules, HttpStatusCode.OK)
    }

    private fun deserializeSchedules(json: String?): List<DayScheduleRecord> {
        if (json.isNullOrBlank()) return emptyList()
        return try {
            val type = object : TypeToken<List<DayScheduleRecord>>() {}.type
            gson.fromJson(json, type) ?: emptyList()
        } catch (e: Exception) {
            logger.error("Error deserializando horarios", e)
            emptyList()
        }
    }

    private fun buildResponse(
        business: String,
        schedules: List<DayScheduleRecord>,
        status: HttpStatusCode = HttpStatusCode.OK
    ): BusinessSchedulesResponse {
        val schedulesMap = mapOf(
            "businessId" to business,
            "schedules" to schedules.map { s ->
                mapOf(
                    "day" to s.day,
                    "isOpen" to s.isOpen,
                    "openTime" to s.openTime,
                    "closeTime" to s.closeTime
                )
            }
        )
        return BusinessSchedulesResponse(schedules = schedulesMap, status = status)
    }
}

data class UpdateSchedulesRequest(
    val schedules: List<DayScheduleRecord> = emptyList()
)
