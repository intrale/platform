package ui.sc.business

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import ext.business.ProductStatus
import kotlinx.coroutines.launch
import ui.cp.buttons.IntralePrimaryButton
import ui.cp.inputs.TextField
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.session.SessionStore
import ui.th.spacing

class ProductFormScreen(
    private val editorStore: ProductEditorStore = ProductEditorStore
) : Screen(BUSINESS_PRODUCT_FORM_PATH) {

    override val messageTitle: MessageKey = MessageKey.product_form_title_create

    @Composable
    override fun screen() {
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(viewModel: ProductFormViewModel = viewModel { ProductFormViewModel() }) {
        val sessionState by SessionStore.sessionState.collectAsState()
        val draft by editorStore.draft.collectAsState()
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()
        var showDeleteDialog by remember { mutableStateOf(false) }

        val businessId = sessionState.selectedBusinessId

        LaunchedEffect(draft) {
            viewModel.applyDraft(draft)
        }

        LaunchedEffect(businessId, draft?.id) {
            if (!businessId.isNullOrBlank()) {
                viewModel.ensureProductLoaded(businessId, draft?.id)
            }
        }

        if (businessId.isNullOrBlank()) {
            MissingBusinessMessage(onBack = { navigate(DASHBOARD_PATH) })
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
                    text = if (viewModel.mode == ProductFormMode.Create) {
                        Txt(MessageKey.product_form_title_create)
                    } else {
                        Txt(MessageKey.product_form_title_edit)
                    },
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.SemiBold
                )

                TextField(
                    label = MessageKey.product_form_name,
                    value = viewModel.uiState.name,
                    state = viewModel[ProductFormUiState::name.name],
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(name = it) }
                )

                TextField(
                    label = MessageKey.product_form_short_description,
                    value = viewModel.uiState.shortDescription,
                    state = viewModel[ProductFormUiState::shortDescription.name],
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(shortDescription = it) }
                )

                TextField(
                    label = MessageKey.product_form_base_price,
                    value = viewModel.uiState.basePrice,
                    state = viewModel[ProductFormUiState::basePrice.name],
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(basePrice = it) }
                )

                TextField(
                    label = MessageKey.product_form_unit,
                    value = viewModel.uiState.unit,
                    state = viewModel[ProductFormUiState::unit.name],
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(unit = it) }
                )

                TextField(
                    label = MessageKey.product_form_category,
                    value = viewModel.uiState.categoryId,
                    state = viewModel[ProductFormUiState::categoryId.name],
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(categoryId = it) }
                )

                StatusSelector(
                    current = viewModel.uiState.status,
                    onSelect = viewModel::updateStatus
                )

                viewModel.errorMessage?.takeIf { it.isNotBlank() }?.let { message ->
                    Text(
                        text = message,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall
                    )
                }

                IntralePrimaryButton(
                    text = Txt(MessageKey.product_form_save),
                    leadingIcon = Icons.Default.Save,
                    iconContentDescription = Txt(MessageKey.product_form_save),
                    loading = viewModel.loading,
                    enabled = !viewModel.loading,
                    onClick = {
                        if (viewModel.isValid()) {
                            callService(
                                coroutineScope = coroutineScope,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.save(businessId) },
                                onSuccess = { product ->
                                    editorStore.setDraft(
                                        ProductDraft(
                                            id = product.id,
                                            name = product.name,
                                            shortDescription = product.shortDescription.orEmpty(),
                                            basePrice = product.basePrice,
                                            unit = product.unit,
                                            categoryId = product.categoryId,
                                            status = product.status
                                        )
                                    )
                                    coroutineScope.launch {
                                        snackbarHostState.showSnackbar(Txt(MessageKey.product_form_saved))
                                    }
                                    navigate(BUSINESS_PRODUCTS_PATH)
                                },
                                onError = { error ->
                                    coroutineScope.launch {
                                        snackbarHostState.showSnackbar(
                                            error.message ?: Txt(MessageKey.error_generic)
                                        )
                                    }
                                }
                            )
                        } else {
                            coroutineScope.launch {
                                snackbarHostState.showSnackbar(Txt(MessageKey.form_error_required))
                            }
                        }
                    }
                )

                if (viewModel.mode == ProductFormMode.Edit) {
                    IntralePrimaryButton(
                        text = Txt(MessageKey.product_form_delete),
                        leadingIcon = Icons.Default.Delete,
                        iconContentDescription = Txt(MessageKey.product_form_delete),
                        enabled = !viewModel.loading,
                        onClick = { showDeleteDialog = true }
                    )
                }
            }
        }

        if (showDeleteDialog) {
            AlertDialog(
                onDismissRequest = { showDeleteDialog = false },
                title = { Text(Txt(MessageKey.product_form_delete_confirm_title)) },
                text = { Text(Txt(MessageKey.product_form_delete_confirm_message)) },
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
                                    snackbarHostState.showSnackbar(Txt(MessageKey.product_form_deleted))
                                }
                                navigate(BUSINESS_PRODUCTS_PATH)
                            }
                        )
                    }) {
                        Text(Txt(MessageKey.product_form_delete_confirm_accept))
                    }
                },
                dismissButton = {
                    TextButton(onClick = { showDeleteDialog = false }) {
                        Text(Txt(MessageKey.product_form_delete_confirm_cancel))
                    }
                }
            )
        }
    }
}

@Composable
private fun StatusSelector(
    current: ProductStatus,
    onSelect: (ProductStatus) -> Unit
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
    ) {
        Text(
            text = Txt(MessageKey.product_form_status),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = androidx.compose.ui.text.font.FontWeight.Medium
        )
        Row(
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            StatusChip(
                label = Txt(MessageKey.business_products_status_draft),
                selected = current == ProductStatus.Draft,
                onClick = { onSelect(ProductStatus.Draft) }
            )
            StatusChip(
                label = Txt(MessageKey.business_products_status_published),
                selected = current == ProductStatus.Published,
                onClick = { onSelect(ProductStatus.Published) }
            )
        }
    }
}

@Composable
private fun StatusChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit
) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label) }
    )
}

@Composable
private fun MissingBusinessMessage(onBack: () -> Unit) {
    Scaffold { padding ->
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(padding)
                .padding(MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.Center
        ) {
            Text(
                text = Txt(MessageKey.product_form_missing_business),
                style = MaterialTheme.typography.bodyLarge
            )
            Spacer(Modifier.size(MaterialTheme.spacing.x2))
            IntralePrimaryButton(
                text = Txt(MessageKey.dashboard_menu_title),
                onClick = onBack
            )
        }
    }
}
