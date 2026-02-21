package ui.sc.client

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.Checkbox
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import kotlinx.coroutines.launch
import ui.cp.buttons.IntralePrimaryButton
import ui.cp.inputs.TextField
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.th.spacing

class AddressFormScreen(
    private val editorStore: AddressEditorStore = AddressEditorStore
) : Screen(CLIENT_ADDRESS_FORM_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_address_form_title_create

    @Composable
    override fun screen() {
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(viewModel: AddressFormViewModel = viewModel { AddressFormViewModel() }) {
        val draft by editorStore.draft.collectAsState()
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()

        val savedMessage = Txt(MessageKey.client_profile_address_saved)
        val genericErrorMessage = Txt(MessageKey.error_generic)
        val formErrorRequiredMessage = Txt(MessageKey.form_error_required)

        LaunchedEffect(draft) {
            viewModel.applyDraft(draft)
        }

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(
                        start = MaterialTheme.spacing.x3,
                        end = MaterialTheme.spacing.x3,
                        top = MaterialTheme.spacing.x3,
                        bottom = MaterialTheme.spacing.x4
                    )
                    .padding(padding),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
            ) {
                Text(
                    text = if (viewModel.mode == AddressFormMode.Create) {
                        Txt(MessageKey.client_address_form_title_create)
                    } else {
                        Txt(MessageKey.client_address_form_title_edit)
                    },
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.SemiBold
                )

                TextField(
                    label = MessageKey.client_profile_address_label,
                    value = viewModel.uiState.label,
                    state = viewModel.inputsStates[AddressFormUiState::label.name]!!,
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(label = it) }
                )

                TextField(
                    label = MessageKey.client_profile_address_line1,
                    value = viewModel.uiState.street,
                    state = viewModel.inputsStates[AddressFormUiState::street.name]!!,
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(street = it) }
                )

                TextField(
                    label = MessageKey.client_profile_address_number,
                    value = viewModel.uiState.number,
                    state = viewModel.inputsStates[AddressFormUiState::number.name]!!,
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(number = it) }
                )

                TextField(
                    label = MessageKey.client_profile_address_reference,
                    value = viewModel.uiState.reference,
                    state = viewModel.inputsStates[AddressFormUiState::reference.name]!!,
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(reference = it) }
                )

                TextField(
                    label = MessageKey.client_profile_address_city,
                    value = viewModel.uiState.city,
                    state = viewModel.inputsStates[AddressFormUiState::city.name]!!,
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(city = it) }
                )

                TextField(
                    label = MessageKey.client_profile_address_state,
                    value = viewModel.uiState.state,
                    state = viewModel.inputsStates[AddressFormUiState::state.name]!!,
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(state = it) }
                )

                TextField(
                    label = MessageKey.client_profile_address_zip,
                    value = viewModel.uiState.postalCode,
                    state = viewModel.inputsStates[AddressFormUiState::postalCode.name]!!,
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(postalCode = it) }
                )

                TextField(
                    label = MessageKey.client_profile_address_country,
                    value = viewModel.uiState.country,
                    state = viewModel.inputsStates[AddressFormUiState::country.name]!!,
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(country = it) }
                )

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Checkbox(
                        checked = viewModel.uiState.isDefault,
                        onCheckedChange = { viewModel.uiState = viewModel.uiState.copy(isDefault = it) }
                    )
                    Text(
                        text = Txt(MessageKey.client_profile_make_default),
                        style = MaterialTheme.typography.bodyMedium
                    )
                }

                viewModel.errorMessage?.takeIf { it.isNotBlank() }?.let { message ->
                    Text(
                        text = message,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall
                    )
                }

                IntralePrimaryButton(
                    text = Txt(MessageKey.client_profile_save_address),
                    leadingIcon = Icons.Default.Save,
                    iconContentDescription = Txt(MessageKey.client_profile_save_address_content_description),
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        if (viewModel.isValid()) {
                            callService(
                                coroutineScope = coroutineScope,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.save() },
                                onSuccess = { savedAddress ->
                                    editorStore.setDraft(
                                        AddressDraft(
                                            id = savedAddress.id,
                                            label = savedAddress.label,
                                            street = savedAddress.street,
                                            number = savedAddress.number,
                                            reference = savedAddress.reference.orEmpty(),
                                            city = savedAddress.city,
                                            state = savedAddress.state.orEmpty(),
                                            postalCode = savedAddress.postalCode.orEmpty(),
                                            country = savedAddress.country.orEmpty(),
                                            isDefault = savedAddress.isDefault
                                        )
                                    )
                                    coroutineScope.launch {
                                        snackbarHostState.showSnackbar(savedMessage)
                                    }
                                    navigate(CLIENT_ADDRESSES_PATH)
                                },
                                onError = { error ->
                                    coroutineScope.launch {
                                        snackbarHostState.showSnackbar(
                                            error.message ?: genericErrorMessage
                                        )
                                    }
                                }
                            )
                        } else {
                            coroutineScope.launch {
                                snackbarHostState.showSnackbar(formErrorRequiredMessage)
                            }
                        }
                    }
                )
            }
        }
    }
}
