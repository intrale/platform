package ui.sc.business

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Error
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.spacing

const val BUSINESS_CHATBOT_PATH = "/business/chatbot"

private val CHATBOT_ALLOWED_ROLES = setOf(UserRole.BusinessAdmin, UserRole.PlatformAdmin)

/**
 * Pantalla de conversaciones del bot de WhatsApp para el flavor Business (#1957).
 *
 * Implementacion inicial ("Proximamente"): la integracion con WhatsApp Business
 * API vive en el backend. Esta pantalla provee el punto de entrada en la app y
 * el estado basico (acceso, negocio, error, coming soon).
 */
class ChatbotConversationsScreen : Screen(BUSINESS_CHATBOT_PATH) {

    override val messageTitle: MessageKey = MessageKey.business_chatbot_title

    private val logger = LoggerFactory.default.newLogger<ChatbotConversationsScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando ChatbotConversationsScreen" }
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(
        viewModel: ChatbotConversationsViewModel = viewModel { ChatbotConversationsViewModel() },
    ) {
        val sessionState by SessionStore.sessionState.collectAsState()
        val snackbarHostState = remember { SnackbarHostState() }

        val businessId = sessionState.selectedBusinessId
        val role = sessionState.role
        val state = viewModel.state

        LaunchedEffect(businessId) {
            viewModel.loadConversations(businessId)
        }

        LaunchedEffect(state.errorMessage) {
            state.errorMessage?.takeIf { it.isNotBlank() }?.let { message ->
                snackbarHostState.showSnackbar(message)
                viewModel.clearError()
            }
        }

        val accessDeniedMessage = Txt(MessageKey.business_chatbot_access_denied)
        val missingBusinessMessage = Txt(MessageKey.business_chatbot_missing_business)
        val emptyMessage = Txt(MessageKey.business_chatbot_empty)
        val errorMessage = Txt(MessageKey.business_chatbot_error)
        val retryLabel = Txt(MessageKey.business_chatbot_retry)
        val comingSoonMessage = Txt(MessageKey.business_chatbot_coming_soon)

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            when {
                role !in CHATBOT_ALLOWED_ROLES -> ChatbotStateMessage(
                    message = accessDeniedMessage,
                    actionLabel = Txt(MessageKey.dashboard_menu_title),
                    onAction = { navigate(DASHBOARD_PATH) },
                    paddingValues = padding,
                )

                state.status == ChatbotConversationsStatus.MissingBusiness -> ChatbotStateMessage(
                    message = missingBusinessMessage,
                    actionLabel = Txt(MessageKey.dashboard_menu_title),
                    onAction = { navigate(DASHBOARD_PATH) },
                    paddingValues = padding,
                )

                else -> ChatbotContent(
                    state = state,
                    paddingValues = padding,
                    emptyMessage = emptyMessage,
                    errorMessage = errorMessage,
                    retryLabel = retryLabel,
                    comingSoonMessage = comingSoonMessage,
                    onRetry = { viewModel.refresh() },
                )
            }
        }
    }
}

@Composable
private fun ChatbotContent(
    state: ChatbotConversationsUiState,
    paddingValues: PaddingValues,
    emptyMessage: String,
    errorMessage: String,
    retryLabel: String,
    comingSoonMessage: String,
    onRetry: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(paddingValues)
            .padding(
                start = MaterialTheme.spacing.x3,
                end = MaterialTheme.spacing.x3,
                top = MaterialTheme.spacing.x3,
                bottom = MaterialTheme.spacing.x5,
            ),
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3),
    ) {
        Text(
            text = Txt(MessageKey.business_chatbot_title),
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = Txt(MessageKey.business_chatbot_description),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        when (state.status) {
            ChatbotConversationsStatus.Loading, ChatbotConversationsStatus.Idle -> {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = MaterialTheme.spacing.x4),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
            }

            ChatbotConversationsStatus.Error -> {
                ChatbotStateCard(
                    icon = Icons.Default.Error,
                    message = state.errorMessage ?: errorMessage,
                    actionLabel = retryLabel,
                    onAction = onRetry,
                )
            }

            ChatbotConversationsStatus.Empty -> {
                ChatbotStateCard(
                    icon = Icons.Default.ChatBubble,
                    message = emptyMessage,
                    actionLabel = retryLabel,
                    onAction = onRetry,
                )
            }

            ChatbotConversationsStatus.ComingSoon -> {
                ChatbotStateCard(
                    icon = Icons.Default.ChatBubble,
                    message = comingSoonMessage,
                    actionLabel = retryLabel,
                    onAction = onRetry,
                )
            }

            ChatbotConversationsStatus.Loaded -> {
                // Cuando el backend exponga el servicio, reemplazar por un
                // LazyColumn de ChatbotConversationItem con preview y badge.
                ChatbotStateCard(
                    icon = Icons.Default.ChatBubble,
                    message = comingSoonMessage,
                    actionLabel = retryLabel,
                    onAction = onRetry,
                )
            }

            ChatbotConversationsStatus.MissingBusiness -> Unit
        }
    }
}

@Composable
private fun ChatbotStateCard(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    message: String,
    actionLabel: String,
    onAction: () -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(imageVector = icon, contentDescription = null)
            Text(
                text = message,
                style = MaterialTheme.typography.bodyLarge,
            )
            IntralePrimaryButton(
                text = actionLabel,
                onClick = onAction,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun ChatbotStateMessage(
    message: String,
    actionLabel: String,
    onAction: () -> Unit,
    paddingValues: PaddingValues,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(paddingValues),
        contentAlignment = Alignment.Center,
    ) {
        ChatbotStateCard(
            icon = Icons.Default.Error,
            message = message,
            actionLabel = actionLabel,
            onAction = onAction,
        )
    }
}
