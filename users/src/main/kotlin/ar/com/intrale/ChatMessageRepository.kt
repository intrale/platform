package ar.com.intrale

import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Modelo interno de mensaje de chat.
 */
data class ChatMessage(
    val id: String = "",
    val orderId: String = "",
    val senderEmail: String = "",
    val senderRole: String = "", // "business" o "delivery"
    val originalText: String = "",
    val originalLanguage: String = "",
    val translatedText: String? = null,
    val translatedLanguage: String? = null,
    val createdAt: String = ""
)

/**
 * Repositorio en memoria para mensajes de chat entre negocio y repartidor.
 * Los mensajes se almacenan por business + orderId.
 */
class ChatMessageRepository {

    // clave: "business#orderId" → lista de mensajes
    private val messages = ConcurrentHashMap<String, MutableList<ChatMessage>>()

    // Mapeo de idioma preferido por usuario (email → languageCode)
    private val userLanguagePreference = ConcurrentHashMap<String, String>()

    private fun chatKey(business: String, orderId: String) =
        "${business.lowercase()}#$orderId"

    /**
     * Guarda un nuevo mensaje en el chat.
     */
    fun saveMessage(
        business: String,
        orderId: String,
        senderEmail: String,
        senderRole: String,
        originalText: String,
        originalLanguage: String,
        translatedText: String?,
        translatedLanguage: String?
    ): ChatMessage {
        val message = ChatMessage(
            id = UUID.randomUUID().toString(),
            orderId = orderId,
            senderEmail = senderEmail,
            senderRole = senderRole,
            originalText = originalText,
            originalLanguage = originalLanguage,
            translatedText = translatedText,
            translatedLanguage = translatedLanguage,
            createdAt = Instant.now().toString()
        )
        messages.getOrPut(chatKey(business, orderId)) { mutableListOf() }.add(message)

        // Actualizar preferencia de idioma del usuario
        if (originalLanguage != "unknown") {
            userLanguagePreference[senderEmail.lowercase()] = originalLanguage
        }

        return message
    }

    /**
     * Retorna todos los mensajes de un chat ordenados cronologicamente.
     */
    fun getMessages(business: String, orderId: String): List<ChatMessage> =
        messages.getOrDefault(chatKey(business, orderId), mutableListOf())
            .map { it.copy() }
            .sortedBy { it.createdAt }

    /**
     * Retorna el idioma preferido de un usuario (basado en sus mensajes anteriores).
     * Si no tiene preferencia registrada, retorna "es" (español por defecto).
     */
    fun getUserLanguagePreference(email: String): String =
        userLanguagePreference[email.lowercase()] ?: "es"

    /**
     * Retorna la cantidad de mensajes en un chat.
     */
    fun messageCount(business: String, orderId: String): Int =
        messages.getOrDefault(chatKey(business, orderId), mutableListOf()).size
}
