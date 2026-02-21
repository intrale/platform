package ui.sc.client

import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import kotlinx.coroutines.launch
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.th.elevations
import ui.th.spacing

const val CLIENT_ADDRESSES_PATH = "/client/addresses"
const val CLIENT_ADDRESS_FORM_PATH = "/client/addresses/form"

class AddressListScreen(
    private val editorStore: AddressEditorStore = AddressEditorStore
) : Screen(CLIENT_ADDRESSES_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_profile_addresses_title

    @Composable
    override fun screen() {
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(viewModel: AddressListViewModel = viewModel { AddressListViewModel() }) {
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()
        val state = viewModel.state

        var addressToDelete by remember { mutableStateOf<AddressListItem?>(null) }
        var deleting by remember { mutableStateOf(false) }

        LaunchedEffect(Unit) {
            viewModel.loadAddresses()
        }

        LaunchedEffect(state.errorMessage) {
            state.errorMessage?.takeIf { it.isNotBlank() }?.let { message ->
                snackbarHostState.showSnackbar(message)
                viewModel.clearError()
            }
        }

        val addLabel = Txt(MessageKey.client_profile_add_address)
        val retryLabel = Txt(MessageKey.client_addresses_retry)
        val emptyMessage = Txt(MessageKey.client_profile_addresses_empty)
        val errorMessage = Txt(MessageKey.client_addresses_error)
        val deleteConfirmTitle = Txt(MessageKey.client_addresses_delete_confirm_title)
        val deleteConfirmMessage = Txt(MessageKey.client_addresses_delete_confirm_message)
        val deleteConfirmAccept = Txt(MessageKey.client_addresses_delete_confirm_accept)
        val deleteConfirmCancel = Txt(MessageKey.client_addresses_delete_confirm_cancel)
        val deletedMessage = Txt(MessageKey.client_profile_address_deleted)
        val genericError = Txt(MessageKey.error_generic)

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            AddressListContent(
                state = state,
                paddingValues = padding,
                addLabel = addLabel,
                emptyMessage = emptyMessage,
                errorMessage = errorMessage,
                retryLabel = retryLabel,
                onAdd = {
                    editorStore.clear()
                    navigate(CLIENT_ADDRESS_FORM_PATH)
                },
                onRetry = { coroutineScope.launch { viewModel.loadAddresses() } },
                onSelect = { item ->
                    editorStore.setDraft(viewModel.toDraft(item))
                    navigate(CLIENT_ADDRESS_FORM_PATH)
                },
                onDelete = { item -> addressToDelete = item }
            )
        }

        addressToDelete?.let { item ->
            AlertDialog(
                onDismissRequest = { addressToDelete = null },
                title = { Text(deleteConfirmTitle) },
                text = { Text(deleteConfirmMessage) },
                confirmButton = {
                    TextButton(
                        onClick = {
                            callService(
                                coroutineScope = coroutineScope,
                                snackbarHostState = snackbarHostState,
                                setLoading = { deleting = it },
                                serviceCall = { viewModel.deleteAddress(item.id) },
                                onSuccess = {
                                    coroutineScope.launch {
                                        snackbarHostState.showSnackbar(deletedMessage)
                                    }
                                    addressToDelete = null
                                },
                                onError = { error ->
                                    snackbarHostState.showSnackbar(
                                        error.message ?: genericError
                                    )
                                }
                            )
                        },
                        enabled = !deleting
                    ) {
                        Text(deleteConfirmAccept)
                    }
                },
                dismissButton = {
                    TextButton(onClick = { addressToDelete = null }) {
                        Text(deleteConfirmCancel)
                    }
                }
            )
        }
    }
}

@Composable
private fun AddressListContent(
    state: AddressListUiState,
    paddingValues: PaddingValues,
    addLabel: String,
    emptyMessage: String,
    errorMessage: String,
    retryLabel: String,
    onAdd: () -> Unit,
    onRetry: () -> Unit,
    onSelect: (AddressListItem) -> Unit,
    onDelete: (AddressListItem) -> Unit
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
                    text = Txt(MessageKey.client_profile_addresses_title),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.SemiBold
                )
                IntralePrimaryButton(
                    text = addLabel,
                    leadingIcon = Icons.Default.Add,
                    iconContentDescription = addLabel,
                    onClick = onAdd,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }

        when (state.status) {
            AddressListStatus.Loading, AddressListStatus.Idle -> {
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

            AddressListStatus.Error -> {
                item {
                    AddressStateCard(
                        icon = Icons.Default.Error,
                        message = state.errorMessage ?: errorMessage,
                        actionLabel = retryLabel,
                        onAction = onRetry
                    )
                }
            }

            AddressListStatus.Empty -> {
                item {
                    AddressStateCard(
                        icon = Icons.Default.LocationOn,
                        message = emptyMessage,
                        actionLabel = addLabel,
                        onAction = onAdd
                    )
                }
            }

            AddressListStatus.Loaded -> {
                items(state.items, key = { it.id }) { item ->
                    AddressCard(
                        item = item,
                        onClick = { onSelect(item) },
                        onDelete = { onDelete(item) }
                    )
                }
            }
        }
    }
}

@Composable
private fun AddressCard(
    item: AddressListItem,
    onClick: () -> Unit,
    onDelete: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1_5)
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1_5),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = item.label,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Medium
                )
                if (item.isDefault) {
                    AssistChip(
                        onClick = {},
                        label = { Text(Txt(MessageKey.client_profile_default_badge)) },
                        leadingIcon = {
                            Icon(
                                imageVector = Icons.Default.Home,
                                contentDescription = null
                            )
                        }
                    )
                }
            }
            Text(
                text = "${item.street} ${item.number}",
                style = MaterialTheme.typography.bodyMedium
            )
            item.reference?.takeIf { it.isNotBlank() }?.let { ref ->
                Text(
                    text = ref,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            val locationParts = listOfNotNull(
                item.city,
                item.state?.takeIf { it.isNotBlank() },
                item.postalCode?.takeIf { it.isNotBlank() },
                item.country?.takeIf { it.isNotBlank() }
            )
            if (locationParts.isNotEmpty()) {
                Text(
                    text = locationParts.joinToString(", "),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Row(
                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
            ) {
                TextButton(onClick = onClick) {
                    Icon(imageVector = Icons.Default.Edit, contentDescription = null)
                    Text(
                        text = Txt(MessageKey.client_profile_edit_address),
                        modifier = Modifier.padding(start = MaterialTheme.spacing.x0_5)
                    )
                }
                TextButton(onClick = onDelete) {
                    Icon(imageVector = Icons.Default.Delete, contentDescription = null)
                    Text(
                        text = Txt(MessageKey.client_profile_delete_address),
                        modifier = Modifier.padding(start = MaterialTheme.spacing.x0_5)
                    )
                }
            }
        }
    }
}

@Composable
private fun AddressStateCard(
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
            Text(
                text = message,
                style = MaterialTheme.typography.bodyLarge
            )
            IntralePrimaryButton(
                text = actionLabel,
                onClick = onAction,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}
