package ui.sc.business

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.business.BusinessDeliveryPerson
import asdo.business.BusinessDeliveryPersonStatus
import kotlinx.coroutines.launch
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.elevations
import ui.th.spacing

const val BUSINESS_DELIVERY_PEOPLE_PATH = "/business/delivery-people"

internal val DELIVERY_PEOPLE_ALLOWED_ROLES = setOf(UserRole.BusinessAdmin, UserRole.PlatformAdmin)

class BusinessDeliveryPeopleScreen : Screen(BUSINESS_DELIVERY_PEOPLE_PATH) {

    override val messageTitle: MessageKey = MessageKey.business_delivery_people_title

    @Composable
    override fun screen() {
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(viewModel: BusinessDeliveryPeopleViewModel = viewModel { BusinessDeliveryPeopleViewModel() }) {
        val sessionState by SessionStore.sessionState.collectAsState()
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()

        val businessId = sessionState.selectedBusinessId
        val role = sessionState.role
        val state = viewModel.state

        LaunchedEffect(businessId) {
            viewModel.load(businessId)
        }

        LaunchedEffect(state.errorMessage) {
            state.errorMessage?.takeIf { it.isNotBlank() }?.let { msg ->
                snackbarHostState.showSnackbar(msg)
                viewModel.clearError()
            }
        }

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            when {
                role !in DELIVERY_PEOPLE_ALLOWED_ROLES -> AccessMessage(
                    message = Txt(MessageKey.business_delivery_people_access_denied),
                    actionLabel = Txt(MessageKey.dashboard_menu_title),
                    onAction = { navigate(DASHBOARD_PATH) },
                    paddingValues = padding
                )

                state.status == BusinessDeliveryPeopleStatus.MissingBusiness -> AccessMessage(
                    message = Txt(MessageKey.business_delivery_people_missing_business),
                    actionLabel = Txt(MessageKey.dashboard_menu_title),
                    onAction = { navigate(DASHBOARD_PATH) },
                    paddingValues = padding
                )

                else -> DeliveryPeopleContent(
                    state = state,
                    paddingValues = padding,
                    onInvite = { viewModel.showInviteDialog() },
                    onRetry = { coroutineScope.launch { viewModel.refresh() } },
                    onToggle = { person ->
                        coroutineScope.launch {
                            viewModel.toggle(person.email, person.status)
                        }
                    }
                )
            }
        }

        if (state.showInviteDialog) {
            InviteDialog(
                email = state.inviteEmail,
                error = state.inviteError,
                inviting = state.inviting,
                onEmailChange = { viewModel.updateInviteEmail(it) },
                onConfirm = {
                    coroutineScope.launch {
                        val result = viewModel.invite()
                        result.onSuccess {
                            snackbarHostState.showSnackbar(Txt(MessageKey.business_delivery_people_invite_success))
                        }
                    }
                },
                onDismiss = { viewModel.dismissInviteDialog() }
            )
        }
    }
}

@Composable
private fun DeliveryPeopleContent(
    state: BusinessDeliveryPeopleUiState,
    paddingValues: PaddingValues,
    onInvite: () -> Unit,
    onRetry: () -> Unit,
    onToggle: (BusinessDeliveryPerson) -> Unit
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(
                start = MaterialTheme.spacing.x3,
                end = MaterialTheme.spacing.x3,
                top = MaterialTheme.spacing.x3,
                bottom = MaterialTheme.spacing.x5
            )
            .padding(paddingValues),
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3),
        contentPadding = PaddingValues(bottom = MaterialTheme.spacing.x4)
    ) {
        item {
            Column(
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(
                    text = Txt(MessageKey.business_delivery_people_title),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.SemiBold
                )
                IntralePrimaryButton(
                    text = Txt(MessageKey.business_delivery_people_invite_action),
                    leadingIcon = Icons.Default.Add,
                    iconContentDescription = Txt(MessageKey.business_delivery_people_invite_action),
                    onClick = onInvite,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }

        when (state.status) {
            BusinessDeliveryPeopleStatus.Loading, BusinessDeliveryPeopleStatus.Idle -> {
                item {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = MaterialTheme.spacing.x4),
                        contentAlignment = Alignment.Center
                    ) {
                        CircularProgressIndicator()
                    }
                }
            }

            BusinessDeliveryPeopleStatus.Error -> {
                item {
                    DeliveryPeopleStateCard(
                        icon = Icons.Default.Error,
                        message = state.errorMessage ?: Txt(MessageKey.business_delivery_people_error),
                        actionLabel = Txt(MessageKey.business_delivery_people_retry),
                        onAction = onRetry
                    )
                }
            }

            BusinessDeliveryPeopleStatus.Empty -> {
                item {
                    DeliveryPeopleStateCard(
                        icon = Icons.Default.Person,
                        message = Txt(MessageKey.business_delivery_people_empty),
                        actionLabel = Txt(MessageKey.business_delivery_people_invite_action),
                        onAction = onInvite
                    )
                }
            }

            BusinessDeliveryPeopleStatus.Loaded -> {
                items(state.people, key = { it.email }) { person ->
                    DeliveryPersonCard(
                        person = person,
                        isToggling = state.togglingEmail == person.email,
                        onToggle = { onToggle(person) }
                    )
                }
            }

            BusinessDeliveryPeopleStatus.MissingBusiness -> Unit
        }
    }
}

@Composable
private fun DeliveryPersonCard(
    person: BusinessDeliveryPerson,
    isToggling: Boolean,
    onToggle: () -> Unit
) {
    val statusLabel = when (person.status) {
        BusinessDeliveryPersonStatus.ACTIVE -> Txt(MessageKey.business_delivery_people_status_active)
        BusinessDeliveryPersonStatus.INACTIVE -> Txt(MessageKey.business_delivery_people_status_inactive)
        BusinessDeliveryPersonStatus.PENDING -> Txt(MessageKey.business_delivery_people_status_pending)
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x0_5)
            ) {
                Text(
                    text = person.fullName.ifBlank { person.email },
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Medium
                )
                if (person.fullName.isNotBlank()) {
                    Text(
                        text = person.email,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Text(
                    text = statusLabel,
                    style = MaterialTheme.typography.bodySmall,
                    color = when (person.status) {
                        BusinessDeliveryPersonStatus.ACTIVE -> MaterialTheme.colorScheme.primary
                        BusinessDeliveryPersonStatus.INACTIVE -> MaterialTheme.colorScheme.error
                        BusinessDeliveryPersonStatus.PENDING -> MaterialTheme.colorScheme.onSurfaceVariant
                    }
                )
            }
            if (person.status != BusinessDeliveryPersonStatus.PENDING) {
                Switch(
                    checked = person.status == BusinessDeliveryPersonStatus.ACTIVE,
                    onCheckedChange = { if (!isToggling) onToggle() },
                    enabled = !isToggling
                )
            }
        }
    }
}

@Composable
private fun DeliveryPeopleStateCard(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    message: String,
    actionLabel: String,
    onAction: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x4),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Icon(imageVector = icon, contentDescription = null)
            Text(text = message, style = MaterialTheme.typography.bodyLarge)
            IntralePrimaryButton(
                text = actionLabel,
                onClick = onAction,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

@Composable
private fun AccessMessage(
    message: String,
    actionLabel: String,
    onAction: () -> Unit,
    paddingValues: PaddingValues
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(paddingValues),
        contentAlignment = Alignment.Center
    ) {
        DeliveryPeopleStateCard(
            icon = Icons.Default.Error,
            message = message,
            actionLabel = actionLabel,
            onAction = onAction
        )
    }
}

@Composable
private fun InviteDialog(
    email: String,
    error: String?,
    inviting: Boolean,
    onEmailChange: (String) -> Unit,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(Txt(MessageKey.business_delivery_people_invite_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)) {
                Text(Txt(MessageKey.business_delivery_people_invite_description))
                OutlinedTextField(
                    value = email,
                    onValueChange = onEmailChange,
                    label = { Text(Txt(MessageKey.business_delivery_people_invite_email_label)) },
                    isError = error != null,
                    supportingText = error?.let { { Text(it) } },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onConfirm, enabled = !inviting) {
                Text(Txt(MessageKey.business_delivery_people_invite_confirm))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(Txt(MessageKey.business_delivery_people_invite_cancel))
            }
        }
    )
}
