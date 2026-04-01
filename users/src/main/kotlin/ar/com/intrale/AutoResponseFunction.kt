package ar.com.intrale

import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

/**
 * Request del cliente: pregunta al agente IA del negocio.
 */
data class AutoResponseRequest(
    val question: String = ""
)

/**
 * Respuesta del agente IA al cliente.
 */
class AutoResponseResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val answer: String = "",
    val isAutomatic: Boolean = true,
    val escalated: Boolean = false,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

class EscalatedResponse(
    val statusCode_value: Map<String, Any> = mapOf("value" to 200, "description" to "OK"),
    val answer: String = "",
    val isAutomatic: Boolean = true,
    val escalated: Boolean = true,
    val message: String = "Tu consulta fue derivada a un representante del negocio. Te responderemos pronto.",
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Endpoint publico (no requiere autenticacion) para que clientes envien
 * consultas al negocio. Si el negocio tiene respuestas automaticas activadas,
 * el agente IA responde. Si no puede, escala al humano.
 *
 * Ruta: POST /{business}/auto-response
 */
class AutoResponseFunction(
    private val logger: Logger,
    private val tableBusiness: DynamoDbTable<Business>,
    private val productRepository: ProductRepository,
    private val aiService: AiResponseService
) : Function {

    private val gson = Gson()

    override suspend fun execute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando auto-response para negocio=$business")

        // Verificar que el negocio existe
        val key = Business().apply { name = business }
        val businessEntity = tableBusiness.getItem(key)
            ?: return ExceptionResponse("Negocio no encontrado", HttpStatusCode.NotFound)

        // Verificar que las respuestas automaticas estan habilitadas
        if (!businessEntity.autoResponseEnabled) {
            logger.debug("Respuestas automaticas desactivadas para negocio=$business")
            return ExceptionResponse(
                "Las respuestas automaticas no estan habilitadas para este negocio",
                HttpStatusCode.Forbidden
            )
        }

        // Parsear request
        val request = parseBody<AutoResponseRequest>(textBody)
            ?: return RequestValidationException("Request body no encontrado")

        if (request.question.isBlank()) {
            return RequestValidationException("La pregunta no puede estar vacia")
        }

        if (request.question.length > 1000) {
            return RequestValidationException("La pregunta no puede superar los 1000 caracteres")
        }

        // Construir contexto del negocio
        val context = buildBusinessContext(businessEntity, business)

        // Generar respuesta IA
        return try {
            val result = aiService.generateResponse(context, request.question)

            if (result.escalated) {
                logger.info("Consulta escalada al humano para negocio=$business")
                EscalatedResponse()
            } else {
                logger.debug("Respuesta automatica generada para negocio=$business (confidence=${result.confidence})")
                AutoResponseResponse(
                    answer = result.answer,
                    isAutomatic = true,
                    escalated = false
                )
            }
        } catch (e: Exception) {
            logger.error("Error generando respuesta automatica para negocio=$business", e)
            // En caso de error, escalar al humano en vez de fallar
            EscalatedResponse()
        }
    }

    internal fun buildBusinessContext(businessEntity: Business, businessName: String): BusinessContext {
        val schedules = deserializeSchedules(businessEntity.schedulesJson)
        val deliveryZone = deserializeDeliveryZone(businessEntity.deliveryZoneJson)
        val paymentMethods = deserializePaymentMethods(businessEntity.paymentMethodsJson)
        val products = productRepository.listPublishedProducts(businessName).map { p ->
            ProductSummary(
                name = p.name,
                shortDescription = p.shortDescription,
                basePrice = p.basePrice,
                unit = p.unit,
                category = p.categoryId,
                isAvailable = p.isAvailable
            )
        }

        return BusinessContext(
            businessName = businessName,
            description = businessEntity.description,
            address = businessEntity.address,
            phone = businessEntity.phone,
            schedules = schedules,
            deliveryZone = deliveryZone,
            paymentMethods = paymentMethods,
            products = products
        )
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

    private fun deserializeDeliveryZone(json: String?): DeliveryZoneRecord? {
        if (json.isNullOrBlank()) return null
        return try {
            gson.fromJson(json, DeliveryZoneRecord::class.java)
        } catch (e: Exception) {
            logger.error("Error deserializando zona de delivery", e)
            null
        }
    }

    private fun deserializePaymentMethods(json: String?): List<PaymentMethodRecord> {
        if (json.isNullOrBlank()) return emptyList()
        return try {
            val type = object : TypeToken<List<PaymentMethodRecord>>() {}.type
            gson.fromJson(json, type) ?: emptyList()
        } catch (e: Exception) {
            logger.error("Error deserializando medios de pago", e)
            emptyList()
        }
    }
}
