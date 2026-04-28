package ui.sc.client

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CenterFocusStrong
import androidx.compose.material.icons.outlined.Map
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.SignalWifiOff
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import asdo.client.SanitizedBusinessZone
import asdo.client.ZoneShape
import kotlinx.coroutines.launch
import ui.sc.shared.Screen

/**
 * Path de la pantalla del mapa de zonas (issue #2423).
 *
 * Se cablea desde `AddressCheckScreen` (Hija A #2422) cuando el cliente
 * toca el boton "Ver zonas de cobertura". El businessId se resuelve via
 * `BuildKonfig.BUSINESS` (un cliente final ve un solo negocio por APK).
 */
const val CLIENT_ZONES_MAP_PATH = "/client/zones-map"

class ZonesMapScreen : Screen(CLIENT_ZONES_MAP_PATH) {

    override val messageTitle: MessageKey = MessageKey.client_zones_map_title

    @Composable
    override fun screen() {
        val viewModel: ZonesMapViewModel = viewModel { ZonesMapViewModel() }
        val state = viewModel.state
        val coroutineScope = rememberCoroutineScope()
        val businessId = ar.com.intrale.BuildKonfig.BUSINESS

        LaunchedEffect(businessId) { viewModel.loadZones(businessId) }

        Scaffold { padding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .background(MaterialTheme.colorScheme.background),
            ) {
                ZonesMapBody(
                    state = state,
                    onRetry = { coroutineScope.launch { viewModel.loadZones(businessId) } },
                    onForceListView = viewModel::forceListView,
                    onToggleListExpanded = viewModel::toggleListExpanded,
                    onBack = { goBack() },
                )

                if (state.phase == ZonesMapPhase.Loaded) {
                    ExtendedFloatingActionButton(
                        onClick = { goBack() },
                        icon = {
                            Icon(
                                imageVector = Icons.Outlined.Refresh,
                                contentDescription = Txt(MessageKey.client_zones_map_back_to_retry_content_description),
                            )
                        },
                        text = { Text(Txt(MessageKey.client_zones_map_back_to_retry)) },
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .padding(16.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun ZonesMapBody(
    state: ZonesMapUIState,
    onRetry: () -> Unit,
    onForceListView: () -> Unit,
    onToggleListExpanded: () -> Unit,
    onBack: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ZonesMapHeader()
        when (state.phase) {
            ZonesMapPhase.Loading -> ZonesMapLoading()
            ZonesMapPhase.Loaded -> ZonesMapLoaded(
                state = state,
                onToggleListExpanded = onToggleListExpanded,
            )
            ZonesMapPhase.Empty -> ZonesMapEmpty(onBack = onBack)
            ZonesMapPhase.Error -> ZonesMapError(
                onRetry = onRetry,
                onShowList = onForceListView,
            )
        }
    }
}

@Composable
private fun ZonesMapHeader() {
    Column(modifier = Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 12.dp)) {
        Text(
            text = Txt(MessageKey.client_zones_map_title),
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.semantics { heading() },
        )
        Text(
            text = Txt(MessageKey.client_zones_map_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
}

@Composable
private fun ZonesMapLoading() {
    val loadingDescription = Txt(MessageKey.client_zones_map_loading_content_description)
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(280.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .semantics { contentDescription = loadingDescription },
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator()
            Text(
                text = Txt(MessageKey.client_zones_map_loading),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = 12.dp),
            )
        }
    }
}

@Composable
private fun ZonesMapLoaded(
    state: ZonesMapUIState,
    onToggleListExpanded: () -> Unit,
) {
    val mapDescription = Txt(MessageKey.client_zones_map_container_content_description)
    val noAndroidBanner = Txt(MessageKey.client_zones_map_no_android_banner)
    val zoneColorsArgb = remember(state.zones.size) {
        ZoneColorPalette.colorsFor(state.zones.size).map { it.toArgb().toLong() and 0xFFFFFFFFL }
    }

    if (!isInteractiveMapAvailable) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 8.dp),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surfaceVariant,
            ),
        ) {
            Text(
                text = noAndroidBanner,
                modifier = Modifier.padding(12.dp),
                style = MaterialTheme.typography.bodySmall,
            )
        }
    } else {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(280.dp)
                .clip(RoundedCornerShape(12.dp))
                .semantics { contentDescription = mapDescription },
        ) {
            ZonesMapPlatformView(
                modifier = Modifier.fillMaxSize(),
                zones = state.zones,
                boundingBox = state.boundingBox,
                zoneColors = zoneColorsArgb,
            )
        }
    }

    LazyRow(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(state.zones) { zone ->
            val index = state.zones.indexOf(zone)
            val color = ZoneColorPalette.colorFor(index)
            val costLabel = formatCurrency(zone.shippingCost, zone.currency)
            val chipDescription = "Zona ${zone.name}, costo $costLabel"
            AssistChip(
                onClick = { /* Pan/zoom integration con mapa - futuro */ },
                label = { Text("${zone.name} — $costLabel") },
                leadingIcon = {
                    Box(
                        modifier = Modifier
                            .size(12.dp)
                            .clip(CircleShape)
                            .background(color),
                    )
                },
                colors = AssistChipDefaults.assistChipColors(),
                modifier = Modifier.semantics { contentDescription = chipDescription },
            )
        }
    }

    TextButton(onClick = onToggleListExpanded, modifier = Modifier.padding(vertical = 4.dp)) {
        Text(
            text = if (state.showsListExpanded) {
                Txt(MessageKey.client_zones_map_hide_list)
            } else {
                Txt(MessageKey.client_zones_map_show_list)
            }
        )
    }

    if (state.showsListExpanded || !isInteractiveMapAvailable) {
        ZonesTextualList(zones = state.zones)
    }
}

@Composable
private fun ZonesTextualList(zones: List<SanitizedBusinessZone>) {
    Text(
        text = Txt(MessageKey.client_zones_map_zones_list_title),
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier
            .padding(top = 8.dp, bottom = 4.dp)
            .semantics { heading() },
    )
    LazyColumn(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 96.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(zones) { zone ->
            val index = zones.indexOf(zone)
            val color = ZoneColorPalette.colorFor(index)
            val costLabel = formatCurrency(zone.shippingCost, zone.currency)
            val itemDescription = "Zona ${zone.name}, costo $costLabel"
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentDescription = itemDescription },
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier
                            .size(16.dp)
                            .clip(CircleShape)
                            .background(color),
                    )
                    Column(modifier = Modifier.padding(start = 12.dp)) {
                        Text(
                            text = zone.name,
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            text = costLabel,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        val detailLabel = when (zone.type) {
                            ZoneShape.POLYGON -> Txt(
                                key = MessageKey.client_zones_map_polygon_count_label,
                                params = mapOf("cantidad" to zone.polygon.size.toString()),
                            )
                            ZoneShape.CIRCLE -> {
                                val meters = zone.radiusMeters?.toLong()?.toString() ?: "0"
                                Txt(
                                    key = MessageKey.client_zones_map_circle_radius_label,
                                    params = mapOf("metros" to meters),
                                )
                            }
                            ZoneShape.UNKNOWN -> ""
                        }
                        if (detailLabel.isNotBlank()) {
                            Text(
                                text = detailLabel,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ZonesMapEmpty(onBack: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            imageVector = Icons.Outlined.Map,
            contentDescription = null,
            modifier = Modifier.size(64.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = Txt(MessageKey.client_zones_map_empty_title),
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .padding(top = 16.dp)
                .semantics { heading() },
        )
        Text(
            text = Txt(MessageKey.client_zones_map_empty_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 8.dp),
        )
        Row(modifier = Modifier.padding(top = 24.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = onBack) {
                Text(Txt(MessageKey.client_zones_map_empty_back))
            }
            // Placeholder: navegacion al perfil del negocio sera cableada cuando exista
            // BusinessProfileScreen del lado del flavor client.
            FilledTonalButton(onClick = onBack) {
                Text(Txt(MessageKey.client_zones_map_empty_business_profile))
            }
        }
    }
}

@Composable
private fun ZonesMapError(
    onRetry: () -> Unit,
    onShowList: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            imageVector = Icons.Outlined.SignalWifiOff,
            contentDescription = null,
            modifier = Modifier.size(64.dp),
            tint = MaterialTheme.colorScheme.error,
        )
        Text(
            text = Txt(MessageKey.client_zones_map_error_title),
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .padding(top = 16.dp)
                .semantics { heading() },
        )
        Text(
            text = Txt(MessageKey.client_zones_map_error_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 8.dp),
        )
        Row(modifier = Modifier.padding(top = 24.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            FilledTonalButton(onClick = onRetry) {
                Text(Txt(MessageKey.client_zones_map_error_retry))
            }
            OutlinedButton(onClick = onShowList) {
                Text(Txt(MessageKey.client_zones_map_error_show_list))
            }
        }
    }
}

/**
 * Formatea costo + moneda sin depender de `NumberFormat` (no existe en
 * commonMain). Para divisas comunes usa `$` (formato local argentino y
 * latinoamericano). Para otras concatena el codigo ISO.
 *
 * Si el costo es entero -> sin decimales. Si tiene decimales -> dos
 * digitos despues del punto, redondeado.
 */
internal fun formatCurrency(cost: Double, currency: String): String {
    val rounded = formatTwoDecimals(cost)
    return when (currency.uppercase()) {
        "ARS", "USD", "MXN", "CLP", "COP" -> "\$$rounded"
        else -> "$rounded $currency"
    }
}

internal fun formatTwoDecimals(value: Double): String {
    if (value % 1.0 == 0.0) return value.toLong().toString()
    val intPart = value.toLong()
    val fractionRaw = ((value - intPart) * 100.0).let {
        if (it < 0) -kotlin.math.round(-it).toLong() else kotlin.math.round(it).toLong()
    }
    val absFraction = if (fractionRaw < 0) -fractionRaw else fractionRaw
    return "$intPart." + absFraction.toString().padStart(2, '0')
}
