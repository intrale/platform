package ar.com.intrale

import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * Request para enviar un mensaje por Telegram Bot API.
 */
data class TelegramSendMessageRequest(
    @SerializedName("chat_id")
    val chatId: String,
    val text: String,
    @SerializedName("parse_mode")
    val parseMode: String = "HTML"
)

/**
 * Respuesta de Telegram Bot API.
 */
data class TelegramApiResponse(
    val ok: Boolean = false,
    val description: String? = null
)

/**
 * Interfaz para el servicio de envio de mensajes.
 */
interface MessageDeliveryService {
    suspend fun sendMessage(contactId: String, text: String): Boolean
}

/**
 * Implementacion de envio de mensajes via Telegram Bot API.
 * El token del bot se obtiene de la variable de entorno TELEGRAM_BOT_TOKEN.
 */
class TelegramDeliveryService(
    private val botToken: String = System.getenv("TELEGRAM_BOT_TOKEN") ?: ""
) : MessageDeliveryService {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
    private val gson = Gson()
    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()

    override suspend fun sendMessage(contactId: String, text: String): Boolean {
        if (botToken.isBlank()) {
            logger.warn("TELEGRAM_BOT_TOKEN no configurado, no se puede enviar reporte")
            return false
        }

        val url = "https://api.telegram.org/bot$botToken/sendMessage"
        val requestBody = TelegramSendMessageRequest(
            chatId = contactId,
            text = text,
            parseMode = "HTML"
        )

        return try {
            val httpRequest = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(requestBody)))
                .timeout(Duration.ofSeconds(15))
                .build()

            val httpResponse = httpClient.send(httpRequest, HttpResponse.BodyHandlers.ofString())

            if (httpResponse.statusCode() == 200) {
                val response = gson.fromJson(httpResponse.body(), TelegramApiResponse::class.java)
                if (response.ok) {
                    logger.info("Mensaje de Telegram enviado exitosamente a chatId=$contactId")
                    true
                } else {
                    logger.error("Telegram API respondio con error: ${response.description}")
                    false
                }
            } else {
                logger.error("Telegram API HTTP error: status=${httpResponse.statusCode()} body=${httpResponse.body()}")
                false
            }
        } catch (e: Exception) {
            logger.error("Error enviando mensaje por Telegram a chatId=$contactId", e)
            false
        }
    }
}

/**
 * Implementacion placeholder para WhatsApp (WhatsApp Business API).
 * Cuando se integre con Meta Cloud API, se completara esta implementacion.
 */
class WhatsAppDeliveryService : MessageDeliveryService {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")

    override suspend fun sendMessage(contactId: String, text: String): Boolean {
        logger.warn("WhatsApp delivery no implementado aun. Mensaje no enviado a contactId=$contactId")
        return false
    }
}
