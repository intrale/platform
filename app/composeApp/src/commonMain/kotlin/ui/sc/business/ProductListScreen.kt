package ui.sc.business

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material.icons.filled.ShoppingBag
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import ext.business.CategoryDTO
import ext.business.ProductStatus
import kotlinx.coroutines.launch
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.elevations
import ui.th.spacing

const val BUSINESS_PRODUCTS_PATH = "/business/products"
const val BUSINESS_PRODUCT_FORM_PATH = "/business/products/form"

private val ALLOWED_ROLES = setOf(UserRole.BusinessAdmin, UserRole.PlatformAdmin)

class ProductListScreen(
    private val editorStore: ProductEditorStore = ProductEditorStore
) : Screen(BUSINESS_PRODUCTS_PATH) {

    override val messageTitle: MessageKey = MessageKey.business_products_title

    @Composable
    override fun screen() {
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(viewModel: ProductListViewModel = viewModel { ProductListViewModel() }) {
        val sessionState by SessionStore.sessionState.collectAsState()
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()

        val businessId = sessionState.selectedBusinessId
        val role = sessionState.role
        val state = viewModel.state

        LaunchedEffect(businessId) {
            viewModel.loadProducts(businessId)
        }

        LaunchedEffect(state.errorMessage) {
            state.errorMessage?.takeIf { it.isNotBlank() }?.let { message ->
                snackbarHostState.showSnackbar(message)
                viewModel.clearError()
            }
        }
        LaunchedEffect(viewModel.categoryError) {
            viewModel.categoryError?.takeIf { it.isNotBlank() }?.let { message ->
                snackbarHostState.showSnackbar(message)
            }
        }

        val addLabel = Txt(MessageKey.business_products_add_action)
        val retryLabel = Txt(MessageKey.business_products_retry)
        val emptyMessage = Txt(MessageKey.business_products_empty)
        val errorMessage = Txt(MessageKey.business_products_error)
        val missingBusinessMessage = Txt(MessageKey.product_list_missing_business)
        val accessDeniedMessage = Txt(MessageKey.business_products_access_denied)

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            when {
                role !in ALLOWED_ROLES -> AccessMessage(
                    message = accessDeniedMessage,
                    actionLabel = Txt(MessageKey.dashboard_menu_title),
                    onAction = { navigate(DASHBOARD_PATH) },
                    paddingValues = padding
                )

                state.status == ProductListStatus.MissingBusiness -> AccessMessage(
                    message = missingBusinessMessage,
                    actionLabel = Txt(MessageKey.dashboard_menu_title),
                    onAction = { navigate(DASHBOARD_PATH) },
                    paddingValues = padding
                )

                else -> ProductListContent(
                    state = state,
                    categories = viewModel.categories,
                    selectedCategoryId = viewModel.selectedCategoryId,
                    onAdd = {
                        editorStore.clear()
                        navigate(BUSINESS_PRODUCT_FORM_PATH)
                    },
                    onRetry = {
                        coroutineScope.launch { viewModel.refresh() }
                    },
                    onSelect = { item ->
                        editorStore.setDraft(viewModel.toDraft(item))
                        navigate(BUSINESS_PRODUCT_FORM_PATH)
                    },
                    onSelectCategory = viewModel::selectCategory,
                    paddingValues = padding,
                    addLabel = addLabel,
                    emptyMessage = emptyMessage,
                    errorMessage = errorMessage,
                    retryLabel = retryLabel
                )
            }
        }
    }
}

@Composable
private fun ProductListContent(
    state: ProductListUiState,
    categories: List<CategoryDTO>,
    selectedCategoryId: String?,
    onAdd: () -> Unit,
    onRetry: () -> Unit,
    onSelect: (ProductListItem) -> Unit,
    onSelectCategory: (String?) -> Unit,
    paddingValues: PaddingValues,
    addLabel: String,
    emptyMessage: String,
    errorMessage: String,
    retryLabel: String
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
                    text = Txt(MessageKey.business_products_title),
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
                CategoryFilter(
                    categories = categories,
                    selectedCategoryId = selectedCategoryId,
                    onSelect = onSelectCategory
                )
            }
        }

        when (state.status) {
            ProductListStatus.Loading, ProductListStatus.Idle -> {
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

            ProductListStatus.Error -> {
                item {
                    ProductStateCard(
                        icon = Icons.Default.Error,
                        message = state.errorMessage ?: errorMessage,
                        actionLabel = retryLabel,
                        onAction = onRetry
                    )
                }
            }

            ProductListStatus.Empty -> {
                item {
                    ProductStateCard(
                        icon = Icons.Default.ShoppingBag,
                        message = emptyMessage,
                        actionLabel = addLabel,
                        onAction = onAdd
                    )
                }
            }

            ProductListStatus.Loaded -> {
                items(state.items, key = { it.id }) { item ->
                    ProductCard(
                        item = item,
                        onClick = { onSelect(item) }
                    )
                }
            }

            ProductListStatus.MissingBusiness -> Unit
        }
    }
}

@Composable
private fun ProductCard(
    item: ProductListItem,
    onClick: () -> Unit
) {
    val statusLabel = when (item.status) {
        ProductStatus.Published -> Txt(MessageKey.business_products_status_published)
        ProductStatus.Draft -> Txt(MessageKey.business_products_status_draft)
    }
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = MaterialTheme.spacing.x0_5)
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
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = item.name,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    AssistChip(
                        onClick = onClick,
                        label = { Text(statusLabel) }
                    )
                    AssistChip(
                        onClick = onClick,
                        label = {
                            Text(
                                if (item.isAvailable) {
                                    Txt(MessageKey.product_form_availability_available)
                                } else {
                                    Txt(MessageKey.product_form_availability_out_of_stock)
                                }
                            )
                        }
                    )
                }
            }
            Text(
                text = item.priceLabel,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = item.unit,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = item.categoryLabel,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            if (item.shortDescription.isNotBlank()) {
                Text(
                    text = item.shortDescription,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

@Composable
private fun ProductStateCard(
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
        ProductStateCard(
            icon = Icons.Default.Error,
            message = message,
            actionLabel = actionLabel,
            onAction = onAction
        )
    }
}

@Composable
private fun CategoryFilter(
    categories: List<CategoryDTO>,
    selectedCategoryId: String?,
    onSelect: (String?) -> Unit
) {
    if (categories.isEmpty()) return
    Column(
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
    ) {
        Text(
            text = Txt(MessageKey.business_products_filter_category),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium
        )
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
        ) {
            FilterChip(
                selected = selectedCategoryId == null,
                onClick = { onSelect(null) },
                label = { Text(Txt(MessageKey.business_products_filter_all)) }
            )
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
