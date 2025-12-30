package ui.sc.business

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.ui.Modifier
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import kotlinx.coroutines.launch
import ui.cp.buttons.IntralePrimaryButton
import ui.cp.inputs.TextField
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.session.SessionStore
import ui.th.spacing

class CategoryFormScreen(
    private val editorStore: CategoryEditorStore = CategoryEditorStore
) : Screen(BUSINESS_CATEGORY_FORM_PATH) {

    override val messageTitle: MessageKey = MessageKey.category_form_title_create

    @Composable
    override fun screen() {
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(viewModel: CategoryFormViewModel = viewModel { CategoryFormViewModel() }) {
        val sessionState by SessionStore.sessionState.collectAsState()
        val draft by editorStore.draft.collectAsState()
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()
        var showDeleteDialog by remember { mutableStateOf(false) }

        val businessId = sessionState.selectedBusinessId
        val role = sessionState.role

        val categorySavedMessage = Txt(MessageKey.category_form_saved)
        val genericErrorMessage = Txt(MessageKey.error_generic)
        val formErrorRequiredMessage = Txt(MessageKey.form_error_required)
        val categoryDeletedMessage = Txt(MessageKey.category_form_deleted)
        val deleteConfirmTitle = Txt(MessageKey.category_form_delete_confirm_title)
        val deleteConfirmMessage = Txt(MessageKey.category_form_delete_confirm_message)
        val deleteConfirmAccept = Txt(MessageKey.category_form_delete_confirm_accept)
        val deleteConfirmCancel = Txt(MessageKey.category_form_delete_confirm_cancel)
        val accessDeniedMessage = Txt(MessageKey.business_categories_access_denied)
        val missingBusinessMessage = Txt(MessageKey.category_list_missing_business)

        LaunchedEffect(draft) {
            viewModel.applyDraft(draft)
        }

        if (role !in CATEGORY_ALLOWED_ROLES) {
            MissingPermissionMessage(accessDeniedMessage, onBack = { navigate(DASHBOARD_PATH) })
            return
        }

        if (businessId.isNullOrBlank()) {
            MissingPermissionMessage(missingBusinessMessage, onBack = { navigate(DASHBOARD_PATH) })
            return
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
                    text = if (viewModel.mode == CategoryFormMode.Create) {
                        Txt(MessageKey.category_form_title_create)
                    } else {
                        Txt(MessageKey.category_form_title_edit)
                    },
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold
                )

                TextField(
                    label = MessageKey.category_form_name,
                    value = viewModel.uiState.name,
                    state = viewModel.inputsStates[CategoryFormUiState::name.name]!!,
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(name = it) }
                )

                TextField(
                    label = MessageKey.category_form_description,
                    value = viewModel.uiState.description,
                    state = viewModel.inputsStates[CategoryFormUiState::description.name]!!,
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(description = it) }
                )

                viewModel.errorMessage?.takeIf { it.isNotBlank() }?.let { message ->
                    Text(
                        text = message,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall
                    )
                }

                IntralePrimaryButton(
                    text = Txt(MessageKey.category_form_save),
                    leadingIcon = Icons.Default.Save,
                    iconContentDescription = Txt(MessageKey.category_form_save),
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        if (viewModel.isValid()) {
                            callService(
                                coroutineScope = coroutineScope,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.save(businessId) },
                                onSuccess = { category ->
                                    editorStore.setDraft(
                                        CategoryDraft(
                                            id = category.id,
                                            name = category.name,
                                            description = category.description.orEmpty(),
                                            productCount = category.productCount
                                        )
                                    )
                                    coroutineScope.launch {
                                        snackbarHostState.showSnackbar(categorySavedMessage)
                                    }
                                    navigate(BUSINESS_CATEGORIES_PATH)
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

                if (viewModel.mode == CategoryFormMode.Edit) {
                    IntralePrimaryButton(
                        text = Txt(MessageKey.category_form_delete),
                        leadingIcon = Icons.Default.Delete,
                        iconContentDescription = Txt(MessageKey.category_form_delete),
                        enabled = !viewModel.loading,
                        onClick = { showDeleteDialog = true }
                    )
                }
            }
        }

        if (showDeleteDialog) {
            AlertDialog(
                onDismissRequest = { showDeleteDialog = false },
                title = { Text(deleteConfirmTitle) },
                text = { Text(deleteConfirmMessage) },
                confirmButton = {
                    TextButton(onClick = {
                        showDeleteDialog = false
                        callService(
                            coroutineScope = coroutineScope,
                            snackbarHostState = snackbarHostState,
                            setLoading = { viewModel.loading = it },
                            serviceCall = { viewModel.delete(businessId) },
                            onSuccess = {
                                editorStore.clear()
                                coroutineScope.launch {
                                    snackbarHostState.showSnackbar(categoryDeletedMessage)
                                }
                                navigate(BUSINESS_CATEGORIES_PATH)
                            }
                        )
                    }) {
                        Text(deleteConfirmAccept)
                    }
                },
                dismissButton = {
                    TextButton(onClick = { showDeleteDialog = false }) {
                        Text(deleteConfirmCancel)
                    }
                }
            )
        }
    }
}

@Composable
private fun MissingPermissionMessage(message: String, onBack: () -> Unit) {
    Scaffold { padding ->
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(padding)
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.Center
        ) {
            Text(
                text = message,
                style = MaterialTheme.typography.bodyLarge
            )
            IntralePrimaryButton(
                text = Txt(MessageKey.dashboard_menu_title),
                onClick = onBack,
                modifier = Modifier.padding(top = MaterialTheme.spacing.x2)
            )
        }
    }
}
