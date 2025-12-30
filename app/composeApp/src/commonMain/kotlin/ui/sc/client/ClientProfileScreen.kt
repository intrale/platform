package ui.sc.client

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Divider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import kotlinx.coroutines.launch
import ui.cp.buttons.IntralePrimaryButton
import ui.cp.inputs.InputState
import ui.cp.inputs.TextField
import ui.sc.auth.CHANGE_PASSWORD_PATH
import ui.sc.auth.TWO_FACTOR_SETUP_PATH
import ui.sc.auth.TWO_FACTOR_VERIFY_PATH
import ui.sc.shared.Screen
import ui.th.spacing

const val CLIENT_PROFILE_PATH = "/client/profile"

class ClientProfileScreen : Screen(CLIENT_PROFILE_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_profile_title

    @Composable
    override fun screen() {
        val viewModel: ClientProfileViewModel = viewModel { ClientProfileViewModel() }
        val state = viewModel.state
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()
        val scrollState = rememberScrollState()

        val retryLabel = Txt(MessageKey.client_profile_retry)
        val successMessage = state.successKey?.let { Txt(it) }

        LaunchedEffect(Unit) {
            viewModel.loadProfile()
        }

        LaunchedEffect(successMessage) {
            successMessage?.let { message ->
                snackbarHostState.showSnackbar(message)
            }
        }

        LaunchedEffect(state.error) {
            state.error?.let { message ->
                snackbarHostState.showSnackbar(message)
            }
        }

        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) },
            bottomBar = {
                ClientBottomBar(
                    activeTab = ClientTab.PROFILE,
                    onHomeClick = { navigate(CLIENT_HOME_PATH) },
                    onOrdersClick = { navigate(CLIENT_ORDERS_PATH) },
                    onProfileClick = {}
                )
            }
        ) { padding ->
            if (state.loading) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    contentAlignment = Alignment.Center
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                    ) {
                        CircularProgressIndicator()
                        Text(Txt(MessageKey.client_profile_loading))
                        TextButton(onClick = { coroutineScope.launch { viewModel.loadProfile() } }) {
                            Text(retryLabel)
                        }
                    }
                }
            } else {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .verticalScroll(scrollState)
                        .padding(MaterialTheme.spacing.x3),
                    verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
                ) {
                    ProfileHeader(
                        name = state.profileForm.fullName,
                        email = state.profileForm.email
                    )
                    PersonalDataCard(
                        viewModel = viewModel,
                        state = state,
                        onSave = { coroutineScope.launch { viewModel.saveProfile() } }
                    )
                    SecurityActionsSection(
                        onChangePassword = { navigate(CHANGE_PASSWORD_PATH) },
                        onSetupTwoFactor = { navigate(TWO_FACTOR_SETUP_PATH) },
                        onVerifyTwoFactor = { navigate(TWO_FACTOR_VERIFY_PATH) },
                        onLogout = {
                            coroutineScope.launch {
                                viewModel.logout()
                                navigate(CLIENT_ENTRY_PATH)
                            }
                        }
                    )
                    AddressesSection(
                        state = state,
                        viewModel = viewModel,
                        onSaveAddress = { coroutineScope.launch { viewModel.saveAddress() } },
                        onDeleteAddress = { id -> coroutineScope.launch { viewModel.deleteAddress(id) } },
                        onEditAddress = { address -> viewModel.startAddressEditing(address) },
                        onDefaultAddress = { id -> coroutineScope.launch { viewModel.markDefault(id) } }
                    )
                    PreferencesSection(
                        state = state,
                        onLanguageChange = viewModel::onLanguageChange
                    )
                }
            }
        }
    }
}

@Composable
private fun ProfileHeader(name: String, email: String) {
    val title = Txt(MessageKey.client_profile_title)
    val subtitle = Txt(MessageKey.client_profile_subtitle)
    val initials = remember(name) { name.trim().takeIf { it.isNotBlank() }?.firstOrNull()?.uppercase() ?: "?" }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
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
                    text = initials,
                    color = MaterialTheme.colorScheme.onPrimary,
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodyMedium
                )
                Text(
                    text = email,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun PersonalDataCard(
    viewModel: ClientProfileViewModel,
    state: ClientProfileUiState,
    onSave: () -> Unit
) {
    val title = Txt(MessageKey.client_profile_personal_data)
    val saveLabel = Txt(MessageKey.client_profile_save_profile)
    val saveContentDescription = Txt(MessageKey.client_profile_save_profile_content_description)

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            TextField(
                label = MessageKey.client_profile_full_name,
                value = state.profileForm.fullName,
                state = viewModel.inputsStates[ClientProfileForm::fullName.name]!!,
                onValueChange = viewModel::onNameChange,
                modifier = Modifier.fillMaxWidth()
            )
            TextField(
                label = MessageKey.client_profile_email_label,
                value = state.profileForm.email,
                state = viewModel.inputsStates[ClientProfileForm::email.name]!!,
                onValueChange = viewModel::onEmailChange,
                modifier = Modifier.fillMaxWidth()
            )
            TextField(
                label = MessageKey.client_profile_phone_label,
                value = state.profileForm.phone,
                state = viewModel.inputsStates[ClientProfileForm::phone.name]!!,
                onValueChange = viewModel::onPhoneChange,
                modifier = Modifier.fillMaxWidth()
            )
            IntralePrimaryButton(
                text = saveLabel,
                onClick = onSave,
                loading = state.savingProfile,
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentDescription = saveContentDescription }
            )
        }
    }
}

@Composable
private fun SecurityActionsSection(
    onChangePassword: () -> Unit,
    onSetupTwoFactor: () -> Unit,
    onVerifyTwoFactor: () -> Unit,
    onLogout: () -> Unit
) {
    val title = Txt(MessageKey.client_profile_security_title)
    val changePasswordLabel = Txt(MessageKey.dashboard_menu_change_password)
    val setupTwoFactorLabel = Txt(MessageKey.dashboard_menu_setup_two_factor)
    val verifyTwoFactorLabel = Txt(MessageKey.dashboard_menu_verify_two_factor)
    val logoutLabel = Txt(MessageKey.dashboard_menu_logout)

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            SecurityActionRow(
                icon = Icons.Default.Security,
                label = changePasswordLabel,
                onClick = onChangePassword
            )
            SecurityActionRow(
                icon = Icons.Default.VerifiedUser,
                label = setupTwoFactorLabel,
                onClick = onSetupTwoFactor
            )
            SecurityActionRow(
                icon = Icons.Default.Check,
                label = verifyTwoFactorLabel,
                onClick = onVerifyTwoFactor
            )
            Divider()
            SecurityActionRow(
                icon = Icons.Default.Logout,
                label = logoutLabel,
                iconTint = MaterialTheme.colorScheme.error,
                onClick = onLogout
            )
        }
    }
}

@Composable
private fun SecurityActionRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    iconTint: Color = MaterialTheme.colorScheme.primary,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(MaterialTheme.colorScheme.surface)
            .clickable(onClick = onClick)
            .padding(vertical = MaterialTheme.spacing.x1_5, horizontal = MaterialTheme.spacing.x2)
            .semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
    ) {
        Icon(
            imageVector = icon,
            contentDescription = label,
            tint = iconTint
        )
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge
        )
    }
}

@Composable
private fun AddressesSection(
    state: ClientProfileUiState,
    viewModel: ClientProfileViewModel,
    onSaveAddress: () -> Unit,
    onDeleteAddress: (String) -> Unit,
    onEditAddress: (asdo.client.ClientAddress) -> Unit,
    onDefaultAddress: (String) -> Unit
) {
    val title = Txt(MessageKey.client_profile_addresses_title)
    val addAddressLabel = Txt(MessageKey.client_profile_add_address)
    val saveAddressLabel = Txt(MessageKey.client_profile_save_address)
    val saveAddressContentDescription = Txt(MessageKey.client_profile_save_address_content_description)
    val emptyMessage = Txt(MessageKey.client_profile_addresses_empty)
    val defaultBadge = Txt(MessageKey.client_profile_default_badge)
    val deleteLabel = Txt(MessageKey.client_profile_delete_address)
    val editLabel = Txt(MessageKey.client_profile_edit_address)
    val defaultLabel = Txt(MessageKey.client_profile_make_default)

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )

            if (state.addresses.isEmpty()) {
                Text(text = emptyMessage, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                state.addresses.forEach { address ->
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(MaterialTheme.spacing.x2),
                            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
                        ) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                            Text(
                                text = address.label,
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.SemiBold
                            )
                                if (address.isDefault) {
                                    AssistChip(
                                        onClick = {},
                                        label = { Text(defaultBadge) },
                                        leadingIcon = {
                                            Icon(
                                                imageVector = Icons.Default.Home,
                                                contentDescription = defaultBadge
                                            )
                                        },
                                        colors = AssistChipDefaults.assistChipColors(
                                            containerColor = MaterialTheme.colorScheme.primaryContainer
                                        )
                                    )
                                }
                            }
                            val streetLine = listOf(address.street, address.number)
                                .filter { it.isNotBlank() }
                                .joinToString(" ")
                            if (streetLine.isNotBlank()) {
                                Text(text = streetLine, style = MaterialTheme.typography.bodyMedium)
                            }
                            if (!address.reference.isNullOrBlank()) {
                                Text(
                                    text = address.reference.orEmpty(),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                            Text(
                                text = listOfNotNull(address.city, address.state, address.postalCode, address.country)
                                    .filter { it.isNotBlank() }
                                    .joinToString(separator = " • "),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                TextButton(onClick = { onEditAddress(address) }) {
                                    Text(editLabel)
                                }
                                TextButton(onClick = { address.id?.let(onDeleteAddress) }) {
                                    Text(deleteLabel)
                                }
                                if (!address.isDefault && address.id != null) {
                                    TextButton(onClick = { onDefaultAddress(address.id) }) {
                                        Text(defaultLabel)
                                    }
                                }
                            }
                        }
                    }
                }
            }

            Divider()
            Text(
                text = addAddressLabel,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold
            )

            TextField(
                label = MessageKey.client_profile_address_label,
                value = state.addressForm.label,
                state = viewModel.inputsStates[AddressForm::label.name]!!,
                onValueChange = { value -> viewModel.onAddressChange { copy(label = value) } },
                modifier = Modifier.fillMaxWidth()
            )
            TextField(
                label = MessageKey.client_profile_address_line1,
                value = state.addressForm.street,
                state = viewModel.inputsStates[AddressForm::street.name]!!,
                onValueChange = { value -> viewModel.onAddressChange { copy(street = value) } },
                modifier = Modifier.fillMaxWidth()
            )
            TextField(
                label = MessageKey.client_profile_address_number,
                value = state.addressForm.number,
                state = viewModel.inputsStates[AddressForm::number.name]!!,
                onValueChange = { value -> viewModel.onAddressChange { copy(number = value) } },
                modifier = Modifier.fillMaxWidth()
            )
            TextField(
                label = MessageKey.client_profile_address_reference,
                value = state.addressForm.reference,
                state = viewModel.inputsStates.getOrPut(AddressForm::reference.name) { mutableStateOf(InputState(AddressForm::reference.name)) },
                onValueChange = { value -> viewModel.onAddressChange { copy(reference = value) } },
                modifier = Modifier.fillMaxWidth()
            )
            TextField(
                label = MessageKey.client_profile_address_city,
                value = state.addressForm.city,
                state = viewModel.inputsStates[AddressForm::city.name]!!,
                onValueChange = { value -> viewModel.onAddressChange { copy(city = value) } },
                modifier = Modifier.fillMaxWidth()
            )
            TextField(
                label = MessageKey.client_profile_address_state,
                value = state.addressForm.state,
                state = viewModel.inputsStates.getOrPut(AddressForm::state.name) { mutableStateOf(InputState(AddressForm::state.name)) },
                onValueChange = { value -> viewModel.onAddressChange { copy(state = value) } },
                modifier = Modifier.fillMaxWidth()
            )
            TextField(
                label = MessageKey.client_profile_address_zip,
                value = state.addressForm.postalCode,
                state = viewModel.inputsStates[AddressForm::postalCode.name]!!,
                onValueChange = { value -> viewModel.onAddressChange { copy(postalCode = value) } },
                modifier = Modifier.fillMaxWidth()
            )
            TextField(
                label = MessageKey.client_profile_address_country,
                value = state.addressForm.country,
                state = viewModel.inputsStates.getOrPut(AddressForm::country.name) { mutableStateOf(InputState(AddressForm::country.name)) },
                onValueChange = { value -> viewModel.onAddressChange { copy(country = value) } },
                modifier = Modifier.fillMaxWidth()
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
            ) {
                androidx.compose.material3.Checkbox(
                    checked = state.addressForm.isDefault,
                    onCheckedChange = { checked -> viewModel.onAddressChange { copy(isDefault = checked) } }
                )
                Text(Txt(MessageKey.client_profile_make_default))
            }

            IntralePrimaryButton(
                text = saveAddressLabel,
                onClick = onSaveAddress,
                loading = state.savingAddress,
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentDescription = saveAddressContentDescription }
            )
        }
    }
}

@Composable
private fun PreferencesSection(
    state: ClientProfileUiState,
    onLanguageChange: (String) -> Unit
) {
    val title = Txt(MessageKey.client_profile_preferences_title)
    val hint = Txt(MessageKey.client_profile_language_hint)
    val languageLabel = Txt(MessageKey.client_profile_language_label)
    val spanish = Txt(MessageKey.client_profile_language_es)
    val english = Txt(MessageKey.client_profile_language_en)

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            Text(text = hint, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(text = languageLabel, style = MaterialTheme.typography.titleSmall)
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3)
            ) {
                LanguageOption(
                    label = spanish,
                    selected = state.profileForm.language.lowercase() == "es",
                    onSelect = { onLanguageChange("es") }
                )
                LanguageOption(
                    label = english,
                    selected = state.profileForm.language.lowercase() == "en",
                    onSelect = { onLanguageChange("en") }
                )
            }
        }
    }
}

@Composable
private fun LanguageOption(
    label: String,
    selected: Boolean,
    onSelect: () -> Unit
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
    ) {
        RadioButton(selected = selected, onClick = onSelect)
        Text(text = label)
    }
}
