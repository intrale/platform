package ar.com.intrale

import io.ktor.http.HttpStatusCode

data class ChatMessageResponse(
    val id: String = "",
    val orderId: String = "",
    val senderEmail: String = "",
    val senderRole: String = "",
    val originalText: String = "",
    val originalLanguage: String = "",
    val translatedText: String? = null,
    val translatedLanguage: String? = null,
    val createdAt: String = "",
    val responseStatus: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = responseStatus)

data class ChatMessagesListResponse(
    val messages: List<ChatMessageResponse> = emptyList(),
    val orderId: String = "",
    val responseStatus: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = responseStatus)

data class ChatSendMessageResponse(
    val message: ChatMessageResponse,
    val wasTranslated: Boolean = false,
    val responseStatus: HttpStatusCode = HttpStatusCode.Created
) : Response(statusCode = responseStatus)
