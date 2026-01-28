package ui.sc.business

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Category
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Error
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.collectAsState
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
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.elevations
import ui.th.spacing

const val BUSINESS_CATEGORIES_PATH = "/business/categories"
const val BUSINESS_CATEGORY_FORM_PATH = "/business/categories/form"

internal val CATEGORY_ALLOWED_ROLES = setOf(UserRole.BusinessAdmin, UserRole.PlatformAdmin)

class CategoryListScreen(
    private val editorStore: CategoryEditorStore = CategoryEditorStore
) : Screen(BUSINESS_CATEGORIES_PATH) {

    override val messageTitle: MessageKey = MessageKey.business_categories_title

    @Composable
    override fun screen() {
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(viewModel: CategoryListViewModel = viewModel { CategoryListViewModel() }) {
        val sessionState by SessionStore.sessionState.collectAsState()
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()

        val businessId = sessionState.selectedBusinessId
        val role = sessionState.role
        val state = viewModel.state

        var categoryToDelete by remember { mutableStateOf<CategoryListItem?>(null) }
        var deleting by remember { mutableStateOf(false) }

        LaunchedEffect(businessId) {
            viewModel.loadCategories(businessId)
        }

        LaunchedEffect(state.errorMessage) {
            state.errorMessage?.takeIf { it.isNotBlank() }?.let { message ->
                snackbarHostState.showSnackbar(message)
                viewModel.clearError()
            }
        }

        val addLabel = Txt(MessageKey.business_categories_add_action)
        val retryLabel = Txt(MessageKey.business_categories_retry)
        val emptyMessage = Txt(MessageKey.business_categories_empty)
        val errorMessage = Txt(MessageKey.business_categories_error)
        val accessDeniedMessage = Txt(MessageKey.business_categories_access_denied)
        val missingBusinessMessage = Txt(MessageKey.category_list_missing_business)
        val deleteConfirmTitle = Txt(MessageKey.category_form_delete_confirm_title)
        val deleteConfirmMessage = Txt(MessageKey.category_form_delete_confirm_message)
        val deleteConfirmAccept = Txt(MessageKey.category_form_delete_confirm_accept)
        val deleteConfirmCancel = Txt(MessageKey.category_form_delete_confirm_cancel)

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            when {
                role !in CATEGORY_ALLOWED_ROLES -> AccessMessage(
                    message = accessDeniedMessage,
                    actionLabel = Txt(MessageKey.dashboard_menu_title),
                    onAction = { navigate(DASHBOARD_PATH) },
                    paddingValues = padding
                )

                state.status == CategoryListStatus.MissingBusiness -> AccessMessage(
                    message = missingBusinessMessage,
                    actionLabel = Txt(MessageKey.dashboard_menu_title),
                    onAction = { navigate(DASHBOARD_PATH) },
                    paddingValues = padding
                )

                else -> CategoryListContent(
                    state = state,
                    paddingValues = padding,
                    addLabel = addLabel,
                    emptyMessage = emptyMessage,
                    errorMessage = errorMessage,
                    retryLabel = retryLabel,
                    onAdd = {
                        editorStore.clear()
                        navigate(BUSINESS_CATEGORY_FORM_PATH)
                    },
                    onRetry = { coroutineScope.launch { viewModel.refresh() } },
                    onSelect = { item ->
                        editorStore.setDraft(viewModel.toDraft(item))
                        navigate(BUSINESS_CATEGORY_FORM_PATH)
                    },
                    onDelete = { item -> categoryToDelete = item }
                )
            }
        }

        categoryToDelete?.let { item ->
            AlertDialog(
                onDismissRequest = { categoryToDelete = null },
                title = { Text(deleteConfirmTitle) },
                text = { Text(deleteConfirmMessage) },
                confirmButton = {
                    TextButton(
                        onClick = {
                            callService(
                                coroutineScope = coroutineScope,
                                snackbarHostState = snackbarHostState,
                                setLoading = { deleting = it },
                                serviceCall = { viewModel.deleteCategory(item.id) },
                                onSuccess = {
                                    coroutineScope.launch {
                                        snackbarHostState.showSnackbar(Txt(MessageKey.category_form_deleted))
                                    }
                                    categoryToDelete = null
                                },
                                onError = { error ->
                                    snackbarHostState.showSnackbar(
                                        error.message ?: Txt(MessageKey.error_generic)
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
                    TextButton(onClick = { categoryToDelete = null }) {
                        Text(deleteConfirmCancel)
                    }
                }
            )
        }
    }
}

@Composable
private fun CategoryListContent(
    state: CategoryListUiState,
    paddingValues: PaddingValues,
    addLabel: String,
    emptyMessage: String,
    errorMessage: String,
    retryLabel: String,
    onAdd: () -> Unit,
    onRetry: () -> Unit,
    onSelect: (CategoryListItem) -> Unit,
    onDelete: (CategoryListItem) -> Unit
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
                    text = Txt(MessageKey.business_categories_title),
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
            CategoryListStatus.Loading, CategoryListStatus.Idle -> {
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

            CategoryListStatus.Error -> {
                item {
                    CategoryStateCard(
                        icon = Icons.Default.Error,
                        message = state.errorMessage ?: errorMessage,
                        actionLabel = retryLabel,
                        onAction = onRetry
                    )
                }
            }

            CategoryListStatus.Empty -> {
                item {
                    CategoryStateCard(
                        icon = Icons.Default.Category,
                        message = emptyMessage,
                        actionLabel = addLabel,
                        onAction = onAdd
                    )
                }
            }

            CategoryListStatus.Loaded -> {
                items(state.items, key = { it.id }) { item ->
                    CategoryCard(
                        item = item,
                        onClick = { onSelect(item) },
                        onDelete = { onDelete(item) }
                    )
                }
            }

            CategoryListStatus.MissingBusiness -> Unit
        }
    }
}

@Composable
private fun CategoryCard(
    item: CategoryListItem,
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
            Text(
                text = item.name,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Medium
            )
            if (item.description.isNotBlank()) {
                Text(
                    text = item.description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            item.productCount?.let { count ->
                Text(
                    text = Txt(
                        MessageKey.business_categories_products_count,
                        mapOf("count" to count.toString())
                    ),
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
                        text = Txt(MessageKey.business_categories_edit),
                        modifier = Modifier.padding(start = MaterialTheme.spacing.x0_5)
                    )
                }
                TextButton(onClick = onDelete) {
                    Icon(imageVector = Icons.Default.Delete, contentDescription = null)
                    Text(
                        text = Txt(MessageKey.business_categories_delete),
                        modifier = Modifier.padding(start = MaterialTheme.spacing.x0_5)
                    )
                }
            }
        }
    }
}

@Composable
private fun CategoryStateCard(
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
        CategoryStateCard(
            icon = Icons.Default.Error,
            message = message,
            actionLabel = actionLabel,
            onAction = onAction
        )
    }
}
