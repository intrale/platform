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
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.Error
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.buttons.IntralePrimaryButton
import ui.sc.shared.Screen
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.elevations
import ui.th.spacing

const val BUSINESS_BANNERS_PATH = "/business/banners"
const val BUSINESS_BANNER_FORM_PATH = "/business/banners/form"

private val BANNER_ALLOWED_ROLES = setOf(UserRole.BusinessAdmin, UserRole.PlatformAdmin)

class BannerListScreen(
    private val editorStore: BannerEditorStore = BannerEditorStore
) : Screen(BUSINESS_BANNERS_PATH) {

    override val messageTitle: MessageKey = MessageKey.business_banners_title

    private val logger = LoggerFactory.default.newLogger<BannerListScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando BannerListScreen" }
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(viewModel: BannerListViewModel = viewModel { BannerListViewModel() }) {
        val sessionState by SessionStore.sessionState.collectAsState()
        val snackbarHostState = remember { SnackbarHostState() }
        val coroutineScope = rememberCoroutineScope()

        val businessId = sessionState.selectedBusinessId
        val role = sessionState.role
        val state = viewModel.state

        LaunchedEffect(businessId) {
            viewModel.loadBanners(businessId)
        }

        LaunchedEffect(state.errorMessage) {
            state.errorMessage?.takeIf { it.isNotBlank() }?.let { message ->
                snackbarHostState.showSnackbar(message)
                viewModel.clearError()
            }
        }

        val addLabel = Txt(MessageKey.business_banners_add_action)
        val retryLabel = Txt(MessageKey.business_banners_retry)
        val emptyMessage = Txt(MessageKey.business_banners_empty)
        val errorMessage = Txt(MessageKey.business_banners_error)
        val accessDeniedMessage = Txt(MessageKey.business_banners_access_denied)
        val missingBusinessMessage = Txt(MessageKey.business_banners_missing_business)

        Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->
            when {
                role !in BANNER_ALLOWED_ROLES -> BannerAccessMessage(
                    message = accessDeniedMessage,
                    actionLabel = Txt(MessageKey.dashboard_menu_title),
                    onAction = { navigate(DASHBOARD_PATH) },
                    paddingValues = padding
                )

                state.status == BannerListStatus.MissingBusiness -> BannerAccessMessage(
                    message = missingBusinessMessage,
                    actionLabel = Txt(MessageKey.dashboard_menu_title),
                    onAction = { navigate(DASHBOARD_PATH) },
                    paddingValues = padding
                )

                else -> BannerListContent(
                    state = state,
                    paddingValues = padding,
                    addLabel = addLabel,
                    emptyMessage = emptyMessage,
                    errorMessage = errorMessage,
                    retryLabel = retryLabel,
                    onAdd = {
                        editorStore.clear()
                        navigate(BUSINESS_BANNER_FORM_PATH)
                    },
                    onRetry = { coroutineScope.launch { viewModel.refresh() } },
                    onSelect = { item ->
                        editorStore.setDraft(viewModel.toDraft(item))
                        navigate(BUSINESS_BANNER_FORM_PATH)
                    },
                    onToggle = { item, active ->
                        coroutineScope.launch {
                            viewModel.toggleBannerActive(item.id, active)
                        }
                    }
                )
            }
        }
    }
}

@Composable
private fun BannerListContent(
    state: BannerListUiState,
    paddingValues: PaddingValues,
    addLabel: String,
    emptyMessage: String,
    errorMessage: String,
    retryLabel: String,
    onAdd: () -> Unit,
    onRetry: () -> Unit,
    onSelect: (BannerListItem) -> Unit,
    onToggle: (BannerListItem, Boolean) -> Unit
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
                    text = Txt(MessageKey.business_banners_title),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = Txt(MessageKey.business_banners_description),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
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
            BannerListStatus.Loading, BannerListStatus.Idle -> {
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

            BannerListStatus.Error -> {
                item {
                    BannerStateCard(
                        icon = Icons.Default.Error,
                        message = state.errorMessage ?: errorMessage,
                        actionLabel = retryLabel,
                        onAction = onRetry
                    )
                }
            }

            BannerListStatus.Empty -> {
                item {
                    BannerStateCard(
                        icon = Icons.Default.Campaign,
                        message = emptyMessage,
                        actionLabel = addLabel,
                        onAction = onAdd
                    )
                }
            }

            BannerListStatus.Loaded -> {
                items(state.items, key = { it.id }) { item ->
                    BannerCard(
                        item = item,
                        onClick = { onSelect(item) },
                        onToggle = { active -> onToggle(item, active) }
                    )
                }
            }

            BannerListStatus.MissingBusiness -> Unit
        }
    }
}

@Composable
private fun BannerCard(
    item: BannerListItem,
    onClick: () -> Unit,
    onToggle: (Boolean) -> Unit
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
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = item.title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.weight(1f)
                )
                Switch(
                    checked = item.active,
                    onCheckedChange = onToggle
                )
            }
            if (item.text.isNotBlank()) {
                Text(
                    text = item.text,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Row(
                horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
            ) {
                Text(
                    text = Txt(
                        MessageKey.business_banners_position,
                        mapOf("position" to item.position)
                    ),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = if (item.active) {
                        Txt(MessageKey.business_banners_status_active)
                    } else {
                        Txt(MessageKey.business_banners_status_inactive)
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = if (item.active) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    }
                )
            }
            TextButton(onClick = onClick) {
                Text(text = Txt(MessageKey.business_banners_edit))
            }
        }
    }
}

@Composable
private fun BannerStateCard(
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
private fun BannerAccessMessage(
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
        BannerStateCard(
            icon = Icons.Default.Error,
            message = message,
            actionLabel = actionLabel,
            onAction = onAction
        )
    }
}
