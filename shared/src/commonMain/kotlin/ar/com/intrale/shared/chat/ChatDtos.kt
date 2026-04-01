package ar.com.intrale.shared.chat

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ChatMessageDTO(
    val id: String = "",
    @SerialName("orderId")
    val orderId: String = "",
    @SerialName("senderEmail")
    val senderEmail: String = "",
    @SerialName("senderRole")
    val senderRole: String = "", // "business" o "delivery"
    @SerialName("originalText")
    val originalText: String = "",
    @SerialName("originalLanguage")
    val originalLanguage: String = "",
    @SerialName("translatedText")
    val translatedText: String? = null,
    @SerialName("translatedLanguage")
    val translatedLanguage: String? = null,
    @SerialName("createdAt")
    val createdAt: String = ""
)

@Serializable
data class SendChatMessageRequest(
    @SerialName("orderId")
    val orderId: String = "",
    val text: String = ""
)

@Serializable
data class ChatMessagesResponseDTO(
    val messages: List<ChatMessageDTO> = emptyList(),
    @SerialName("orderId")
    val orderId: String = ""
)
