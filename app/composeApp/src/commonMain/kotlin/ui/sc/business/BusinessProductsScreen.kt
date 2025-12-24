package ui.sc.business

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
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.ShoppingBag
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import kotlinx.coroutines.launch
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.elevations
import ui.th.spacing

const val BUSINESS_PRODUCTS_PATH = "/business/products"
const val BUSINESS_PRODUCT_EDIT_PATH = "/business/products/edit"

fun businessProductEditRoute(productId: String? = null): String {
    return buildString {
        append(BUSINESS_PRODUCT_EDIT_PATH)
        productId?.let { append("?productId=$it") }
    }
}

private val ALLOWED_ROLES = setOf(UserRole.BusinessAdmin, UserRole.PlatformAdmin)

class BusinessProductsScreen : Screen(BUSINESS_PRODUCTS_PATH) {

    override val messageTitle: MessageKey = MessageKey.business_products_title

    @Composable
    override fun screen() {
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(viewModel: BusinessProductsViewModel = viewModel { BusinessProductsViewModel() }) {
        val sessionState by SessionStore.sessionState.collectAsState()
        val coroutineScope = rememberCoroutineScope()

        val businessId = sessionState.selectedBusinessId
        val hasAccess = sessionState.role in ALLOWED_ROLES && !businessId.isNullOrBlank()

        val addLabel = Txt(MessageKey.business_products_add_action)
        val accessDeniedMessage = Txt(MessageKey.business_products_access_denied)
        val emptyMessage = Txt(MessageKey.business_products_empty)
        val errorMessage = Txt(MessageKey.business_products_error)
        val retryLabel = Txt(MessageKey.business_products_retry)

        LaunchedEffect(businessId) {
            businessId?.let { viewModel.loadProducts(it) }
        }

        if (!hasAccess) {
            Text(
                text = accessDeniedMessage,
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x4)
            )
            return
        }

        val state = viewModel.state

        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = MaterialTheme.spacing.x3, vertical = MaterialTheme.spacing.x3),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3),
            contentPadding = PaddingValues(bottom = MaterialTheme.spacing.x6)
        ) {
            item {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
                ) {
                    Text(
                        text = Txt(MessageKey.business_products_title),
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.SemiBold
                    )
                    IntralePrimaryButton(
                        text = addLabel,
                        onClick = { navigate(businessProductEditRoute()) },
                        leadingIcon = Icons.Default.Add,
                        iconContentDescription = addLabel,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }

            item {
                BusinessProductsFilters(
                    selected = state.selectedFilter,
                    onSelected = { filter ->
                        businessId?.let { id ->
                            coroutineScope.launch { viewModel.updateFilter(id, filter) }
                        }
                    }
                )
            }

            when {
                state.isLoading -> {
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

                state.errorMessage != null -> {
                    item {
                        BusinessProductsStateCard(
                            icon = Icons.Default.Error,
                            message = state.errorMessage.ifBlank { errorMessage },
                            actionLabel = retryLabel,
                            onAction = {
                                businessId?.let { id ->
                                    coroutineScope.launch { viewModel.loadProducts(id) }
                                }
                            }
                        )
                    }
                }

                state.products.isEmpty() -> {
                    item {
                        BusinessProductsStateCard(
                            icon = Icons.Default.ShoppingBag,
                            message = emptyMessage,
                            actionLabel = addLabel,
                            onAction = { navigate(businessProductEditRoute()) }
                        )
                    }
                }

                else -> {
                    items(state.products, key = { it.id }) { product ->
                        BusinessProductCard(
                            product = product,
                            onClick = { navigate(businessProductEditRoute(product.id)) }
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun BusinessProductsFilters(
    selected: BusinessProductsFilter,
    onSelected: (BusinessProductsFilter) -> Unit
) {
    val filters = listOf(
        BusinessProductsFilter.ALL to Txt(MessageKey.business_products_filter_all),
        BusinessProductsFilter.PUBLISHED to Txt(MessageKey.business_products_filter_published),
        BusinessProductsFilter.DRAFT to Txt(MessageKey.business_products_filter_drafts)
    )
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
    ) {
        filters.forEach { (filter, label) ->
            AssistChip(
                onClick = { onSelected(filter) },
                label = { Text(label) },
                leadingIcon = {
                    Icon(
                        imageVector = Icons.Default.ShoppingBag,
                        contentDescription = null
                    )
                },
                colors = AssistChipDefaults.assistChipColors(
                    containerColor = if (filter == selected) {
                        MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
                    } else {
                        MaterialTheme.colorScheme.surfaceVariant
                    }
                ),
                border = AssistChipDefaults.assistChipBorder(
                    borderColor = if (filter == selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant
                )
            )
        }
    }
}

@Composable
private fun BusinessProductCard(
    product: BusinessProduct,
    onClick: () -> Unit
) {
    val statusLabel = when (product.status) {
        BusinessProductStatus.Published -> Txt(MessageKey.business_products_status_published)
        BusinessProductStatus.Draft -> Txt(MessageKey.business_products_status_draft)
        BusinessProductStatus.Unknown -> Txt(MessageKey.business_products_status_unknown)
    }
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = MaterialTheme.elevations.level1)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(MaterialTheme.spacing.x3),
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = product.emoji,
                style = MaterialTheme.typography.headlineMedium
            )
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
            ) {
                Text(
                    text = product.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    text = product.priceLabel,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = statusLabel,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary
                )
            }
        }
    }
}

@Composable
private fun BusinessProductsStateCard(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    message: String,
    actionLabel: String,
    onAction: () -> Unit,
    buttonIcon: androidx.compose.ui.graphics.vector.ImageVector = icon
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
                style = MaterialTheme.typography.bodyLarge,
                textAlign = TextAlign.Center
            )
            IntralePrimaryButton(
                text = actionLabel,
                onClick = onAction,
                leadingIcon = buttonIcon,
                iconContentDescription = actionLabel,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}
