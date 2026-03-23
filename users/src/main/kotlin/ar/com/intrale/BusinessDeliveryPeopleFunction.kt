package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

data class BusinessDeliveryPersonPayload(
    val email: String = "",
    val fullName: String = "",
    val status: String = "PENDING"
)

data class BusinessDeliveryPeopleListResponse(
    val deliveryPeople: List<BusinessDeliveryPersonPayload> = emptyList(),
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class ToggleDeliveryPersonStatusRequest(
    val email: String = "",
    val newStatus: String = ""
)

data class ToggleDeliveryPersonStatusResponse(
    val email: String = "",
    val newStatus: String = "",
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

data class InviteDeliveryPersonRequest(
    val email: String = ""
)

data class InviteDeliveryPersonResponse(
    val email: String = "",
    val message: String = "",
    val status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

class BusinessDeliveryPeopleFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val deliveryProfileRepository: DeliveryProfileRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config, logger, jwtValidator) {

    private val gson = Gson()

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()
        val subPath = function.removePrefix("business/delivery-people").trimStart('/')

        return when {
            method == HttpMethod.Get.value.uppercase() && subPath.isBlank() -> {
                logger.info("Listando repartidores del negocio {}", business)
                val records = deliveryProfileRepository.listByBusiness(business)
                val people = records.map { record ->
                    BusinessDeliveryPersonPayload(
                        email = record.profile.email,
                        fullName = record.profile.fullName,
                        status = record.status.name
                    )
                }
                BusinessDeliveryPeopleListResponse(deliveryPeople = people)
            }

            method == HttpMethod.Put.value.uppercase() && subPath == "status" -> {
                val request = try {
                    gson.fromJson(textBody, ToggleDeliveryPersonStatusRequest::class.java)
                } catch (e: Exception) {
                    return RequestValidationException("Body invalido para cambio de estado de repartidor")
                }

                if (request.email.isBlank()) {
                    return RequestValidationException("email es requerido")
                }
                val newStatus = try {
                    DeliveryPersonStatus.valueOf(request.newStatus.uppercase())
                } catch (e: IllegalArgumentException) {
                    return RequestValidationException("Estado invalido: ${request.newStatus}. Valores validos: ACTIVE, INACTIVE")
                }
                if (newStatus == DeliveryPersonStatus.PENDING) {
                    return RequestValidationException("No se puede asignar estado PENDING manualmente")
                }

                logger.info("Cambiando estado del repartidor {} a {} en negocio {}", request.email, newStatus, business)
                val updated = deliveryProfileRepository.toggleStatus(business, request.email, newStatus)
                ToggleDeliveryPersonStatusResponse(
                    email = updated.profile.email,
                    newStatus = updated.status.name
                )
            }

            method == HttpMethod.Post.value.uppercase() && subPath == "invite" -> {
                val request = try {
                    gson.fromJson(textBody, InviteDeliveryPersonRequest::class.java)
                } catch (e: Exception) {
                    return RequestValidationException("Body invalido para invitacion de repartidor")
                }

                if (request.email.isBlank()) {
                    return RequestValidationException("email es requerido para la invitacion")
                }

                logger.info("Invitando repartidor {} al negocio {}", request.email, business)
                val record = deliveryProfileRepository.invite(business, request.email)
                InviteDeliveryPersonResponse(
                    email = record.profile.email,
                    message = "Invitacion registrada para ${record.profile.email}"
                )
            }

            else -> RequestValidationException("Metodo o ruta no soportados: $method ($subPath)")
        }
    }
}
