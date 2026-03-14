package ui.sc.business

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
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
import ext.business.CategoryDTO
import ext.business.ProductStatus
import kotlinx.coroutines.launch
import ui.cp.buttons.IntralePrimaryButton
import ui.cp.inputs.TextField
import ui.sc.shared.Screen
import ui.sc.shared.callService
import ui.session.SessionStore
import ui.th.spacing

private val UNIT_OPTIONS = listOf("kg", "g", "unidad", "docena", "litro", "ml", "porcion")

class ProductFormScreen(
    private val editorStore: ProductEditorStore = ProductEditorStore
) : Screen(BUSINESS_PRODUCT_FORM_PATH) {

    override val messageTitle: MessageKey = MessageKey.product_form_title_create

    @Composable
    override fun screen() {
        ScreenContent()
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun ScreenContent(viewModel: ProductFormViewModel = viewModel { ProductFormViewModel() }) {
        val sessionState by SessionStore.sessionState.collectAsState()
        val draft by editorStore.draft.collectAsState()
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()
        var showDeleteDialog by remember { mutableStateOf(false) }
        var unitExpanded by remember { mutableStateOf(false) }

        val businessId = sessionState.selectedBusinessId
        val productSavedMessage = Txt(MessageKey.product_form_saved)
        val genericErrorMessage = Txt(MessageKey.error_generic)
        val formErrorRequiredMessage = Txt(MessageKey.form_error_required)
        val productDeletedMessage = Txt(MessageKey.product_form_deleted)
        val deleteConfirmTitle = Txt(MessageKey.product_form_delete_confirm_title)
        val deleteConfirmMessage = Txt(MessageKey.product_form_delete_confirm_message)
        val deleteConfirmAccept = Txt(MessageKey.product_form_delete_confirm_accept)
        val deleteConfirmCancel = Txt(MessageKey.product_form_delete_confirm_cancel)
        val refreshCategoriesLabel = Txt(MessageKey.business_categories_retry)
        val stockHelperText = Txt(MessageKey.product_form_stock_helper)

        LaunchedEffect(draft) {
            viewModel.applyDraft(draft)
        }

        LaunchedEffect(businessId, draft?.id) {
            if (!businessId.isNullOrBlank()) {
                viewModel.ensureProductLoaded(businessId, draft?.id)
            }
        }

        LaunchedEffect(businessId) {
            viewModel.loadCategories(businessId)
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
                    state = viewModel.inputsStates[ProductFormUiState::name.name]!!,
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(name = it) }
                )

                TextField(
                    label = MessageKey.product_form_short_description,
                    value = viewModel.uiState.shortDescription,
                    state = viewModel.inputsStates[ProductFormUiState::shortDescription.name]!!,
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(shortDescription = it) }
                )

                // Precio con prefijo $ para indicar moneda
                TextField(
                    label = MessageKey.product_form_base_price,
                    value = viewModel.uiState.basePrice,
                    state = viewModel.inputsStates[ProductFormUiState::basePrice.name]!!,
                    onValueChange = { viewModel.uiState = viewModel.uiState.copy(basePrice = it) },
                    leadingIcon = { Text("$", style = MaterialTheme.typography.bodyLarge) }
                )

                // Unidad como dropdown con opciones predefinidas
                ExposedDropdownMenuBox(
                    expanded = unitExpanded,
                    onExpandedChange = { unitExpanded = it },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    OutlinedTextField(
                        value = viewModel.uiState.unit,
                        onValueChange = {},
                        readOnly = true,
                        label = {
                            Text(
                                Txt(MessageKey.product_form_unit),
                                style = MaterialTheme.typography.labelMedium
                            )
                        },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = unitExpanded) },
                        singleLine = true,
                        textStyle = MaterialTheme.typography.bodyLarge,
                        shape = MaterialTheme.shapes.medium,
                        modifier = Modifier
                            .fillMaxWidth()
                            .menuAnchor(MenuAnchorType.PrimaryNotEditable, enabled = true)
                    )
                    ExposedDropdownMenu(
                        expanded = unitExpanded,
                        onDismissRequest = { unitExpanded = false }
                    ) {
                        UNIT_OPTIONS.forEach { unit ->
                            DropdownMenuItem(
                                text = { Text(unit, style = MaterialTheme.typography.bodyLarge) },
                                onClick = {
                                    viewModel.uiState = viewModel.uiState.copy(unit = unit)
                                    unitExpanded = false
                                }
                            )
                        }
                    }
                }

                CategorySelector(
                    categories = viewModel.categories,
                    selectedCategoryId = viewModel.uiState.categoryId,
                    loading = viewModel.categoriesLoading,
                    errorMessage = viewModel.categoryError,
                    retryLabel = refreshCategoriesLabel,
                    onRetry = { viewModel.loadCategories(businessId) },
                    onSelect = viewModel::updateCategory
                )

                StatusSelector(
                    current = viewModel.uiState.status,
                    onSelect = viewModel::updateStatus
                )

                AvailabilitySelector(
                    isAvailable = viewModel.uiState.isAvailable,
                    onSelect = viewModel::updateAvailability
                )

                StockQuantityField(
                    value = viewModel.uiState.stockQuantity,
                    helperText = stockHelperText,
                    onValueChange = viewModel::updateStockQuantity
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
                                            status = product.status,
                                            isAvailable = product.isAvailable,
                                            stockQuantity = product.stockQuantity
                                        )
                                    )
                                    coroutineScope.launch {
                                        snackbarHostState.showSnackbar(productSavedMessage)
                                    }
                                    navigate(BUSINESS_PRODUCTS_PATH)
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

                // Botón de eliminar con estilo destructivo (error color)
                if (viewModel.mode == ProductFormMode.Edit) {
                    Button(
                        onClick = { showDeleteDialog = true },
                        enabled = !viewModel.loading,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                            contentColor = MaterialTheme.colorScheme.onError
                        ),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(
                            imageVector = Icons.Default.Delete,
                            contentDescription = Txt(MessageKey.product_form_delete)
                        )
                        Spacer(Modifier.size(ButtonDefaults.IconSpacing))
                        Text(Txt(MessageKey.product_form_delete))
                    }
                }
            }
        }

        if (showDeleteDialog) {
            AlertDialog(
                onDismissRequest = { showDeleteDialog = false },
                title = { Text(deleteConfirmTitle) },
                text = { Text(deleteConfirmMessage) },
                confirmButton = {
                    // Botón de confirmación de eliminación con estilo destructivo
                    Button(
                        onClick = {
                            showDeleteDialog = false
                            callService(
                                coroutineScope = coroutineScope,
                                snackbarHostState = snackbarHostState,
                                setLoading = { viewModel.loading = it },
                                serviceCall = { viewModel.delete(businessId) },
                                onSuccess = {
                                    editorStore.clear()
                                    coroutineScope.launch {
                                        snackbarHostState.showSnackbar(productDeletedMessage)
                                    }
                                    navigate(BUSINESS_PRODUCTS_PATH)
                                }
                            )
                        },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                            contentColor = MaterialTheme.colorScheme.onError
                        )
                    ) {
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
private fun CategorySelector(
    categories: List<CategoryDTO>,
    selectedCategoryId: String,
    loading: Boolean,
    errorMessage: String?,
    retryLabel: String,
    onRetry: suspend () -> Unit,
    onSelect: (String) -> Unit
) {
    val coroutineScope = rememberCoroutineScope()
    Column(
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
    ) {
        Text(
            text = Txt(MessageKey.product_form_category),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium
        )
        when {
            loading -> {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.Start
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(MaterialTheme.spacing.x3))
                }
            }

            categories.isEmpty() -> {
                Text(
                    text = Txt(MessageKey.product_form_category_empty),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                TextButton(
                    onClick = { coroutineScope.launch { onRetry() } }
                ) {
                    Text(retryLabel)
                }
            }

            else -> {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1_5),
                    verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
                ) {
                    categories.forEach { category ->
                        val id = category.id ?: return@forEach
                        FilterChip(
                            selected = selectedCategoryId == id,
                            onClick = { onSelect(id) },
                            label = { Text(category.name) }
                        )
                    }
                }
            }
        }

        errorMessage?.takeIf { it.isNotBlank() }?.let { message ->
            Text(
                text = message,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall
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
private fun AvailabilitySelector(
    isAvailable: Boolean,
    onSelect: (Boolean) -> Unit
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
    ) {
        Text(
            text = Txt(MessageKey.product_form_availability),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium
        )
        Row(
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            FilterChip(
                selected = isAvailable,
                onClick = { onSelect(true) },
                label = { Text(Txt(MessageKey.product_form_available)) }
            )
            FilterChip(
                selected = !isAvailable,
                onClick = { onSelect(false) },
                label = { Text(Txt(MessageKey.product_form_out_of_stock)) }
            )
        }
    }
}

@Composable
private fun StockQuantityField(
    value: String,
    helperText: String,
    onValueChange: (String) -> Unit
) {
    OutlinedTextField(
        value = value,
        onValueChange = { newValue ->
            if (newValue.isEmpty() || newValue.all { it.isDigit() }) {
                onValueChange(newValue)
            }
        },
        label = {
            Text(
                Txt(MessageKey.product_form_stock_quantity),
                style = MaterialTheme.typography.labelMedium
            )
        },
        supportingText = {
            Text(
                text = helperText,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        textStyle = MaterialTheme.typography.bodyLarge,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth()
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
