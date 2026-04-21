package ui.sc.business

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.konform.validation.Validation
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

/**
 * Estado del listado de conversaciones del bot de WhatsApp.
 *
 * Este ViewModel es un scaffolding inicial del feature #1957. La integracion
 * real con WhatsApp Business API vive en el backend; la app se limita a
 * mostrar las conversaciones y permitir el takeover humano.
 */
enum class ChatbotConversationsStatus { Idle, Loading, Loaded, Empty, Error, MissingBusiness, ComingSoon }

/** Canal que gestiona una conversacion en un momento dado. */
enum class ChatbotAuthor { Bot, Human }

data class ChatbotConversationItem(
    val id: String,
    val customerName: String,
    val customerPhone: String,
    val lastMessagePreview: String,
    val lastAuthor: ChatbotAuthor,
    val unreadCount: Int,
    val updatedAtLabel: String,
)

data class ChatbotConversationsUiState(
    val status: ChatbotConversationsStatus = ChatbotConversationsStatus.ComingSoon,
    val items: List<ChatbotConversationItem> = emptyList(),
    val errorMessage: String? = null,
)

class ChatbotConversationsViewModel(
    loggerFactory: LoggerFactory = LoggerFactory.default,
) : ViewModel() {

    private val logger = loggerFactory.newLogger<ChatbotConversationsViewModel>()
    private var currentBusinessId: String? = null

    var state by mutableStateOf(ChatbotConversationsUiState())
        private set

    override fun getState(): Any = state

    init {
        @Suppress("UNCHECKED_CAST")
        validation = Validation<ChatbotConversationsUiState> { } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf()
    }

    /**
     * Carga las conversaciones del negocio. Por ahora devuelve "coming soon"
     * porque el backend todavia no expone el servicio; cuando este listo se
     * reemplaza por la invocacion al `ToDoListChatbotConversations`.
     */
    fun loadConversations(businessId: String?) {
        if (businessId.isNullOrBlank()) {
            logger.warning { "No hay negocio seleccionado para cargar conversaciones del bot" }
            state = state.copy(
                status = ChatbotConversationsStatus.MissingBusiness,
                items = emptyList(),
                errorMessage = null,
            )
            return
        }
        currentBusinessId = businessId
        logger.info { "Mostrando estado 'proximamente' para conversaciones del negocio $businessId" }
        state = state.copy(
            status = ChatbotConversationsStatus.ComingSoon,
            items = emptyList(),
            errorMessage = null,
        )
    }

    fun refresh() {
        loadConversations(currentBusinessId)
    }

    fun clearError() {
        if (state.errorMessage != null) {
            state = state.copy(errorMessage = null)
        }
    }
}
