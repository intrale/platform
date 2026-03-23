@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package ui.sc.business

import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.cp.inputs.InputState
import ui.cp.inputs.TextField
import ui.cp.loading.DashboardSkeletonContent
import ui.cp.loading.EmptyState
import ui.cp.loading.ErrorState
import ui.sc.delivery.DELIVERY_DASHBOARD_PATH
import ui.sc.shared.Screen
import ui.th.spacing

const val DASHBOARD_PATH = "/dashboard"

class DashboardScreen : Screen(DASHBOARD_PATH) {

    override val messageTitle: MessageKey = MessageKey.dashboard_title

    private val logger = LoggerFactory.default.newLogger<DashboardScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando Dashboard" }
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(viewModel: DashboardViewModel = viewModel { DashboardViewModel() }) {
        val coroutineScope = rememberCoroutineScope()
        val uiState = viewModel.state
        val selectorLabel = Txt(MessageKey.dashboard_business_selector_label)
        val businessName = if (uiState.selectedBusinessName.isNotBlank()) {
            uiState.selectedBusinessName
        } else {
            Txt(MessageKey.dashboard_business_header_empty)
        }

        LaunchedEffect(Unit) {
            coroutineScope.launch { viewModel.loadDashboard() }
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(
                    horizontal = MaterialTheme.spacing.x3,
                    vertical = MaterialTheme.spacing.x4
                ),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            if (uiState.isBusinessLoading) {
                // Skeleton loading mientras se cargan los datos iniciales
                DashboardSkeletonContent()
            } else if (uiState.businessError != null) {
                // Error al cargar negocios - estado de error con reintentar
                ErrorState(
                    title = Txt(MessageKey.dashboard_error_title),
                    description = Txt(MessageKey.dashboard_error_description),
                    retryLabel = Txt(MessageKey.dashboard_summary_retry),
                    onRetry = { coroutineScope.launch { viewModel.loadDashboard() } }
                )
            } else {
                // Encabezado: nombre del negocio + subtitulo + descripcion
                Text(
                    text = businessName,
                    style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier.semantics { heading() }
                )
                Text(
                    text = Txt(MessageKey.dashboard_admin_subtitle),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.semantics { heading() }
                )
                Text(
                    text = Txt(MessageKey.dashboard_manage_intro),
                    style = MaterialTheme.typography.bodyMedium
                )

                if (uiState.businesses.size > 1) {
                    var expanded by remember { mutableStateOf(false) }
                    val inputState = remember { mutableStateOf(InputState("businessSelector")) }
                    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
                        TextField(
                            label = MessageKey.dashboard_business_selector_label,
                            value = uiState.selectedBusinessName,
                            state = inputState,
                            modifier = Modifier.menuAnchor(),
                            onValueChange = {},
                            enabled = true
                        )
                        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                            uiState.businesses.forEach { business ->
                                DropdownMenuItem(
                                    text = { Text(business.name) },
                                    onClick = {
                                        coroutineScope.launch { viewModel.selectBusiness(business.id) }
                                        expanded = false
                                    }
                                )
                            }
                        }
                    }
                    Text(
                        text = selectorLabel,
                        style = MaterialTheme.typography.bodySmall
                    )
                }

                DashboardSummarySection(
                    state = uiState.summaryState,
                    onRetry = { coroutineScope.launch { viewModel.refreshSummary() } },
                    onNavigateProducts = { navigate(BUSINESS_PRODUCTS_PATH) }
                )
            }
        }
    }

    @Composable
    private fun DashboardSummarySection(
        state: BusinessDashboardSummaryState,
        onRetry: () -> Unit,
        onNavigateProducts: () -> Unit
    ) {
        when (state) {
            BusinessDashboardSummaryState.Loading -> {
                // Skeleton loading para la seccion de metricas
                DashboardSkeletonContent()
            }
            BusinessDashboardSummaryState.MissingBusiness -> {
                EmptyState(
                    title = Txt(MessageKey.dashboard_empty_title),
                    description = Txt(MessageKey.dashboard_business_missing)
                )
            }
            BusinessDashboardSummaryState.Empty -> {
                EmptyState(
                    title = Txt(MessageKey.dashboard_summary_empty_title),
                    description = Txt(MessageKey.dashboard_summary_empty_description),
                    actionLabel = Txt(MessageKey.dashboard_summary_empty_cta),
                    onAction = onNavigateProducts
                )
            }
            is BusinessDashboardSummaryState.Error -> {
                ErrorState(
                    title = Txt(MessageKey.dashboard_error_title),
                    description = Txt(MessageKey.dashboard_summary_error),
                    retryLabel = Txt(MessageKey.dashboard_summary_retry),
                    onRetry = onRetry
                )
            }
            is BusinessDashboardSummaryState.Loaded -> {
                val summary = state.summary
                Column(verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)) {
                    DashboardActionCard(
                        title = Txt(MessageKey.dashboard_card_products_title),
                        description = Txt(MessageKey.dashboard_card_products_description),
                        metric = Txt(
                            MessageKey.dashboard_card_products_metric,
                            mapOf("count" to summary.productsCount.toString())
                        ),
                        actions = listOf(
                            Txt(MessageKey.dashboard_card_products_cta_catalog) to { navigate(BUSINESS_PRODUCTS_PATH) },
                            Txt(MessageKey.dashboard_card_products_cta_add) to { navigate(BUSINESS_PRODUCT_FORM_PATH) }
                        )
                    )
                    DashboardActionCard(
                        title = Txt(MessageKey.dashboard_card_orders_title),
                        description = Txt(MessageKey.dashboard_card_orders_description),
                        metric = Txt(
                            MessageKey.dashboard_card_orders_metric,
                            mapOf("count" to summary.pendingOrders.toString())
                        ),
                        actions = listOf(
                            Txt(MessageKey.dashboard_card_orders_cta_pending) to { navigate(BUSINESS_ORDERS_PATH) },
                            Txt(MessageKey.dashboard_card_orders_cta_history) to { navigate(BUSINESS_ORDERS_PATH) }
                        )
                    )
                    DashboardActionCard(
                        title = Txt(MessageKey.dashboard_card_delivery_title),
                        description = Txt(MessageKey.dashboard_card_delivery_description),
                        metric = Txt(
                            MessageKey.dashboard_card_delivery_metric,
                            mapOf("count" to summary.activeDrivers.toString())
                        ),
                        actions = listOf(
                            Txt(MessageKey.dashboard_card_delivery_cta_drivers) to { navigate(DELIVERY_DASHBOARD_PATH) },
                            Txt(MessageKey.dashboard_card_delivery_cta_invite) to { navigate(DELIVERY_DASHBOARD_PATH) }
                        )
                    )
                    DashboardActionCard(
                        title = Txt(MessageKey.dashboard_card_business_config_title),
                        description = Txt(MessageKey.dashboard_card_business_config_description),
                        metric = Txt(MessageKey.dashboard_card_business_config_metric),
                        actions = listOf(
                            Txt(MessageKey.dashboard_card_business_config_cta) to { navigate(BUSINESS_CONFIG_PATH) }
                        )
                    )
                    DashboardActionCard(
                        title = Txt(MessageKey.dashboard_card_banners_title),
                        description = Txt(MessageKey.dashboard_card_banners_description),
                        metric = Txt(MessageKey.dashboard_card_banners_metric),
                        actions = listOf(
                            Txt(MessageKey.dashboard_card_banners_cta) to { navigate(BUSINESS_BANNERS_PATH) }
                        )
                    )
                    DashboardActionCard(
                        title = Txt(MessageKey.dashboard_card_schedules_title),
                        description = Txt(MessageKey.dashboard_card_schedules_description),
                        metric = "",
                        actions = listOf(
                            Txt(MessageKey.dashboard_card_schedules_cta) to { navigate(BUSINESS_SCHEDULES_PATH) }
                        )
                    )
                    DashboardActionCard(
                        title = Txt(MessageKey.dashboard_card_delivery_zone_title),
                        description = Txt(MessageKey.dashboard_card_delivery_zone_description),
                        metric = "",
                        actions = listOf(
                            Txt(MessageKey.dashboard_card_delivery_zone_cta) to { navigate(BUSINESS_DELIVERY_ZONE_PATH) }
                        )
                    )
                    DashboardActionCard(
                        title = Txt(MessageKey.dashboard_card_payment_methods_title),
                        description = Txt(MessageKey.dashboard_card_payment_methods_description),
                        metric = "",
                        actions = listOf(
                            Txt(MessageKey.dashboard_card_payment_methods_cta) to { navigate(BUSINESS_PAYMENT_METHODS_PATH) }
                        )
                    )
                    DashboardActionCard(
                        title = Txt(MessageKey.dashboard_card_settings_title),
                        description = Txt(MessageKey.dashboard_card_settings_description),
                        metric = Txt(MessageKey.dashboard_card_settings_metric),
                        actions = listOf(
                            Txt(MessageKey.dashboard_card_settings_cta) to { navigate(PERSONALIZATION_PATH) }
                        )
                    )
                }
            }
        }
    }

    @Composable
    private fun DashboardActionCard(
        title: String,
        description: String,
        metric: String,
        actions: List<Pair<String, () -> Unit>>
    ) {
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x2),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
            ) {
                // Sección de información: título + descripción + métrica se fusionan para
                // lectores de pantalla (TalkBack/VoiceOver), anunciándose como una sola unidad.
                Column(
                    modifier = Modifier.semantics(mergeDescendants = true) { },
                    verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x1)
                ) {
                    Text(
                        text = title,
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.semantics { heading() }
                    )
                    Text(
                        text = description,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(text = metric, style = MaterialTheme.typography.bodySmall)
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End
                ) {
                    actions.forEach { (label, onClick) ->
                        TextButton(onClick = onClick) {
                            Text(text = label)
                        }
                    }
                }
            }
        }
        Spacer(modifier = Modifier.size(MaterialTheme.spacing.x0_5))
    }
}
