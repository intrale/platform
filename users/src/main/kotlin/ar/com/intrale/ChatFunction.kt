package ar.com.intrale

import com.auth0.jwt.JWT
import com.google.gson.Gson
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

/**
 * Funcion de chat bidireccional entre negocio y repartidor con traduccion automatica.
 *
 * Endpoints:
 * - GET  chat/messages?orderId=xxx         → Lista mensajes del chat de un pedido
 * - POST chat/messages                     → Envia un mensaje (detecta idioma, traduce si hace falta)
 *
 * El rol del sender se determina por el header X-Chat-Role ("business" o "delivery").
 * La traduccion se hace via Claude API cuando los idiomas de los participantes difieren.
 */
class ChatFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val repository: ChatMessageRepository,
    private val translationService: TranslationService,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config, logger, jwtValidator) {

    private val gson = Gson()

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        val email = resolveEmail(headers) ?: return UnauthorizedException()
        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()
        val senderRole = headers["X-Chat-Role"]?.lowercase() ?: "business"

        if (senderRole !in setOf("business", "delivery")) {
            return RequestValidationException("X-Chat-Role debe ser 'business' o 'delivery'")
        }

        return when (method) {
            HttpMethod.Get.value.uppercase() -> handleGetMessages(business, headers)
            HttpMethod.Post.value.uppercase() -> handleSendMessage(business, email, senderRole, textBody)
            else -> RequestValidationException("Metodo no soportado para chat: $method")
        }
    }

    private fun handleGetMessages(business: String, headers: Map<String, String>): Response {
        val orderId = headers["X-Query-orderId"]
            ?: return RequestValidationException("El parametro orderId es requerido")

        logger.info("Consultando mensajes del chat para pedido $orderId en negocio $business")

        val messages = repository.getMessages(business, orderId)
        val responseMessages = messages.map { it.toResponse() }

        return ChatMessagesListResponse(
            messages = responseMessages,
            orderId = orderId,
            responseStatus = HttpStatusCode.OK
        )
    }

    private suspend fun handleSendMessage(
        business: String,
        senderEmail: String,
        senderRole: String,
        textBody: String
    ): Response {
        if (textBody.isBlank()) {
            return RequestValidationException("El body del request no puede estar vacio")
        }

        val request = try {
            gson.fromJson(textBody, SendChatMessageRequest::class.java)
        } catch (e: Exception) {
            return RequestValidationException("Formato de mensaje invalido")
        }

        if (request.orderId.isBlank()) {
            return RequestValidationException("El orderId es requerido")
        }
        if (request.text.isBlank()) {
            return RequestValidationException("El texto del mensaje es requerido")
        }

        logger.info("Enviando mensaje de chat: sender=$senderEmail role=$senderRole orderId=${request.orderId}")

        // Determinar el idioma objetivo: el idioma del otro participante
        val targetLanguage = determineTargetLanguage(business, request.orderId, senderRole)

        // Detectar idioma y traducir si es necesario
        val translationResult = translationService.detectAndTranslate(request.text, targetLanguage)

        // Guardar el mensaje
        val saved = repository.saveMessage(
            business = business,
            orderId = request.orderId,
            senderEmail = senderEmail,
            senderRole = senderRole,
            originalText = request.text,
            originalLanguage = translationResult.detectedLanguage,
            translatedText = translationResult.translatedText,
            translatedLanguage = translationResult.targetLanguage
        )

        logger.info("Mensaje guardado: id=${saved.id} idioma=${translationResult.detectedLanguage} " +
                "traducido=${translationResult.translatedText != null}")

        return ChatSendMessageResponse(
            message = saved.toResponse(),
            wasTranslated = translationResult.translatedText != null,
            responseStatus = HttpStatusCode.Created
        )
    }

    /**
     * Determina el idioma objetivo para la traduccion.
     * Busca el ultimo mensaje del otro rol en la conversacion y usa su idioma.
     * Si no hay mensajes previos, retorna "es" (español por defecto).
     */
    private fun determineTargetLanguage(
        business: String,
        orderId: String,
        senderRole: String
    ): String {
        val messages = repository.getMessages(business, orderId)
        val otherRoleMessage = messages
            .filter { it.senderRole != senderRole }
            .maxByOrNull { it.createdAt }

        return otherRoleMessage?.originalLanguage ?: "es"
    }

    private fun resolveEmail(headers: Map<String, String>): String? {
        val token = headers["Authorization"] ?: headers["authorization"]
        val decoded = token
            ?.removePrefix("Bearer ")
            ?.takeIf { it.isNotBlank() }
            ?.let { runCatching { JWT.decode(it) }.getOrNull() }

        return decoded?.getClaim("email")?.asString()
            ?: decoded?.subject
            ?: headers["X-Debug-User"]
    }

    private fun ChatMessage.toResponse() = ChatMessageResponse(
        id = id,
        orderId = orderId,
        senderEmail = senderEmail,
        senderRole = senderRole,
        originalText = originalText,
        originalLanguage = originalLanguage,
        translatedText = translatedText,
        translatedLanguage = translatedLanguage,
        createdAt = createdAt
    )
}

/**
 * Request interno para enviar un mensaje de chat.
 */
data class SendChatMessageRequest(
    val orderId: String = "",
    val text: String = ""
)
