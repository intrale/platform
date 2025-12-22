package ui.sc.client

import DIManager
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.auth.CHANGE_PASSWORD_PATH
import ui.sc.auth.TWO_FACTOR_SETUP_PATH
import ui.sc.auth.TWO_FACTOR_VERIFY_PATH
import ui.sc.shared.Screen
import ui.session.SessionStore
import ui.th.elevations
import ui.th.spacing
import asdo.auth.ToDoResetLoginCache

const val CLIENT_PROFILE_PATH = "/client/profile"

data class ClientProfileUiState(
    val fullName: String = "Cliente Intrale",
    val email: String = "cliente@intrale.com",
    val phone: String = "+54 11 5555-0000"
)

class ClientProfileScreen : Screen(CLIENT_PROFILE_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_profile_title

    @Composable
    override fun screen() {
        val viewModel: ClientProfileViewModel = viewModel { ClientProfileViewModel() }
        val uiState = viewModel.state
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()

        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) }
        ) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(horizontal = MaterialTheme.spacing.x4, vertical = MaterialTheme.spacing.x3),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
            ) {
                ClientProfileHeader(uiState)

                ClientProfileInfoCard(uiState)

                ClientProfileActionsCard(title = Txt(MessageKey.client_profile_shortcuts_title)) {
                    ClientProfileAction(
                        icon = Icons.Default.Home,
                        label = Txt(MessageKey.client_profile_manage_addresses),
                        description = Txt(MessageKey.client_profile_addresses_helper)
                    ) {
                        coroutineScope.launch {
                            snackbarHostState.showSnackbar(Txt(MessageKey.client_profile_addresses_helper))
                        }
                    }
                    ClientProfileAction(
                        icon = Icons.Default.Settings,
                        label = Txt(MessageKey.client_profile_preferences),
                        description = Txt(MessageKey.client_profile_preferences_helper)
                    ) {
                        coroutineScope.launch {
                            snackbarHostState.showSnackbar(Txt(MessageKey.client_profile_preferences_helper))
                        }
                    }
                }

                ClientProfileActionsCard(title = Txt(MessageKey.client_profile_security_title)) {
                    ClientProfileAction(
                        icon = Icons.Default.Key,
                        label = Txt(MessageKey.dashboard_menu_change_password),
                        description = Txt(MessageKey.login_change_password_title)
                    ) {
                        navigate(CHANGE_PASSWORD_PATH)
                    }
                    ClientProfileAction(
                        icon = Icons.Default.VerifiedUser,
                        label = Txt(MessageKey.dashboard_menu_setup_two_factor),
                        description = Txt(MessageKey.dashboard_menu_verify_two_factor)
                    ) {
                        navigate(TWO_FACTOR_SETUP_PATH)
                    }
                    ClientProfileAction(
                        icon = Icons.Default.VerifiedUser,
                        label = Txt(MessageKey.dashboard_menu_verify_two_factor),
                        description = Txt(MessageKey.login_change_password_description)
                    ) {
                        navigate(TWO_FACTOR_VERIFY_PATH)
                    }
                }

                ClientProfileSessionCard(
                    onLogout = {
                        coroutineScope.launch {
                            viewModel.logout()
                            navigate(CLIENT_ENTRY_PATH)
                        }
                    }
                )
            }
        }
    }
}

@Composable
private fun ClientProfileHeader(state: ClientProfileUiState) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
        ) {
            Box(
                modifier = Modifier
                    .size(64.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = state.fullName.firstOrNull()?.uppercase() ?: "C",
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.onPrimary,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5)) {
                Text(
                    text = state.fullName,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onPrimaryContainer
                )
                Text(
                    text = state.email,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer
                )
            }
        }
    }
}

@Composable
private fun ClientProfileInfoCard(state: ClientProfileUiState) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Text(
                text = Txt(MessageKey.client_profile_basic_info_title),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface
            )

            ClientProfileInfoRow(label = Txt(MessageKey.client_profile_name_label), value = state.fullName)
            ClientProfileInfoRow(label = Txt(MessageKey.client_profile_email_label), value = state.email)
            ClientProfileInfoRow(label = Txt(MessageKey.client_profile_phone_label), value = state.phone)
        }
    }
}

@Composable
private fun ClientProfileInfoRow(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5)) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
            fontWeight = FontWeight.Medium
        )
    }
}

@Composable
private fun ClientProfileActionsCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface
            )
            content()
        }
    }
}

@Composable
private fun ClientProfileAction(
    icon: ImageVector,
    label: String,
    description: String,
    iconTint: Color = MaterialTheme.colorScheme.primary,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
            .clickable(onClick = onClick)
            .padding(horizontal = MaterialTheme.spacing.x3, vertical = MaterialTheme.spacing.x2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
    ) {
        Icon(imageVector = icon, contentDescription = label, tint = iconTint)
        Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5)) {
            Text(
                text = label,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface
            )
            Text(
                text = description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun ClientProfileSessionCard(onLogout: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Text(
                text = Txt(MessageKey.client_profile_session_title),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface
            )
            Text(
                text = Txt(MessageKey.client_profile_logout_helper),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            IntralePrimaryButton(
                text = Txt(MessageKey.client_profile_logout_label),
                onClick = onLogout,
                leadingIcon = Icons.Default.Logout,
                iconContentDescription = Txt(MessageKey.client_profile_logout_label),
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

class ClientProfileViewModel : ui.sc.shared.ViewModel() {

    private val toDoResetLoginCache: ToDoResetLoginCache by DIManager.di.instance()
    private val logger = LoggerFactory.default.newLogger<ClientProfileViewModel>()

    var state by mutableStateOf(ClientProfileUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() { /* No-op */ }

    suspend fun logout() {
        logger.info { "Ejecutando logout desde pantalla de perfil" }
        toDoResetLoginCache.execute()
        SessionStore.clear()
    }
}
