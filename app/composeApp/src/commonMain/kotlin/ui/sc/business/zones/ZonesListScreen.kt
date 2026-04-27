package ui.sc.business.zones

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.TravelExplore
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import ar.com.intrale.shared.business.DeliveryZoneDTO
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import kotlinx.coroutines.launch
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.session.SessionStore
import ui.sc.shared.Screen
import ui.th.ZonesPalette
import ui.th.fillFor

const val BUSINESS_DELIVERY_ZONES_PATH = "/businessDeliveryZones"

/**
 * Pantalla principal del feature "Zonas de delivery — visualizacion read-only" — split 1 #2420.
 *
 * Layout: mapa full-screen con bottom-sheet de lista (UX seccion 1).
 * Para el split 1, simplificamos a un Column vertical (mapa arriba 60%, lista abajo).
 * El bottom-sheet con 3 estados (peek/half/expanded) es una mejora de polish que
 * puede aterrizar en split 2 sin alterar la API publica de la pantalla.
 *
 * Estados:
 * - Loading -> CircularProgressIndicator + shimmer en lista (CA-3-L).
 * - Empty -> empty state card sobre el mapa (CA-2-L).
 * - Loaded / LoadedFromCache -> mapa + lista de zonas, banner offline si aplica.
 * - Error -> card con CTA reintentar.
 * - Sin Google Play Services -> fallback CTAs Play Store (CA-7-L).
 */
class ZonesListScreen : Screen(BUSINESS_DELIVERY_ZONES_PATH) {

    override val messageTitle: MessageKey = MessageKey.business_delivery_zones_title

    private val logger = LoggerFactory.default.newLogger<ZonesListScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando ZonesListScreen" }
        ScreenContent()
    }

    @Composable
    private fun ScreenContent(
        viewModel: DeliveryZonesViewModel = viewModel { DeliveryZonesViewModel() }
    ) {
        val coroutineScope = rememberCoroutineScope()
        val uiState = viewModel.state
        val sessionState = SessionStore.sessionState.collectAsState().value
        val businessId = sessionState.selectedBusinessId
        val isDark = isSystemInDarkTheme()
        val snackbarHostState = remember { SnackbarHostState() }
        val mapAvailable = isMapAvailable()
        val ctaSoonText = Txt(MessageKey.business_delivery_zones_cta_soon)

        LaunchedEffect(businessId) {
            viewModel.loadZones(businessId)
        }

        // CA-7-L: si no hay Google Play Services, mostrar fallback completo.
        if (!mapAvailable) {
            PlayServicesFallbackCard(modifier = Modifier.fillMaxSize())
            return
        }

        Box(modifier = Modifier.fillMaxSize()) {
            Column(modifier = Modifier.fillMaxSize()) {
                // Banner offline (CA-5-L) — solo si los datos vienen de cache.
                if (uiState.status is DeliveryZonesStatus.LoadedFromCache) {
                    OfflineBanner()
                }

                // Mapa: 60% del alto vertical (CA-3-L: ">= 60% vertical").
                Box(modifier = Modifier.fillMaxWidth().weight(0.6f)) {
                    ZonesMapContent(
                        zones = uiState.zones,
                        selectedZoneId = uiState.selectedZoneId,
                        isDarkTheme = isDark,
                        onZoneTap = { id -> viewModel.selectZone(id) },
                        fallbackCenter = OBELISCO_CABA,
                        modifier = Modifier.fillMaxSize()
                    )
                }

                // Panel inferior: lista o estados (loading / empty / error).
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(0.4f)
                        .background(MaterialTheme.colorScheme.surface)
                ) {
                    when (uiState.status) {
                        DeliveryZonesStatus.Loading -> LoadingState()
                        DeliveryZonesStatus.Empty -> EmptyState(
                            onAddCircular = {
                                coroutineScope.launch { snackbarHostState.showSnackbar(ctaSoonText) }
                            },
                            onAddPolygon = {
                                coroutineScope.launch { snackbarHostState.showSnackbar(ctaSoonText) }
                            }
                        )
                        DeliveryZonesStatus.Error -> ErrorState(
                            message = uiState.errorMessage,
                            onRetry = {
                                coroutineScope.launch { viewModel.loadZones(businessId) }
                            }
                        )
                        DeliveryZonesStatus.MissingBusiness -> MissingBusinessState()
                        DeliveryZonesStatus.Loaded,
                        is DeliveryZonesStatus.LoadedFromCache -> ZonesList(
                            zones = uiState.zones,
                            selectedZoneId = uiState.selectedZoneId,
                            isDark = isDark,
                            onZoneTap = { id -> viewModel.selectZone(id) }
                        )
                        DeliveryZonesStatus.Idle -> Unit
                    }
                }
            }

            SnackbarHost(
                hostState = snackbarHostState,
                modifier = Modifier.align(Alignment.BottomCenter)
            ) { data -> Snackbar(snackbarData = data) }
        }
    }

    @Composable
    private fun OfflineBanner() {
        Surface(
            color = MaterialTheme.colorScheme.secondaryContainer,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 40.dp)
                .semantics {
                    contentDescription = "Modo sin conexion, datos guardados"
                }
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Icon(
                    imageVector = Icons.Outlined.CloudOff,
                    contentDescription = null,
                    modifier = Modifier.size(20.dp),
                    tint = MaterialTheme.colorScheme.onSecondaryContainer
                )
                Text(
                    text = Txt(MessageKey.business_delivery_zones_offline_banner),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSecondaryContainer
                )
            }
        }
    }

    @Composable
    private fun LoadingState() {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                CircularProgressIndicator()
                Text(
                    text = Txt(MessageKey.business_delivery_zones_loading),
                    style = MaterialTheme.typography.bodyMedium
                )
            }
        }
    }

    @Composable
    private fun EmptyState(onAddCircular: () -> Unit, onAddPolygon: () -> Unit) {
        Box(
            modifier = Modifier.fillMaxSize().padding(16.dp),
            contentAlignment = Alignment.Center
        ) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surface
                )
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Icon(
                        imageVector = Icons.Outlined.TravelExplore,
                        contentDescription = null,
                        modifier = Modifier.size(56.dp),
                        tint = MaterialTheme.colorScheme.primary
                    )
                    Text(
                        text = Txt(MessageKey.business_delivery_zones_empty_title),
                        style = MaterialTheme.typography.titleMedium
                    )
                    Text(
                        text = Txt(MessageKey.business_delivery_zones_empty_subtitle),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(modifier = Modifier.size(4.dp))
                    Button(
                        onClick = onAddCircular,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                    ) {
                        Icon(Icons.Outlined.Add, contentDescription = null)
                        Spacer(modifier = Modifier.size(8.dp))
                        Text(text = Txt(MessageKey.business_delivery_zones_empty_cta_circular))
                    }
                    OutlinedButton(
                        onClick = onAddPolygon,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                    ) {
                        Icon(Icons.Outlined.Edit, contentDescription = null)
                        Spacer(modifier = Modifier.size(8.dp))
                        Text(text = Txt(MessageKey.business_delivery_zones_empty_cta_polygon))
                    }
                }
            }
        }
    }

    @Composable
    private fun ErrorState(message: String?, onRetry: () -> Unit) {
        Box(
            modifier = Modifier.fillMaxSize().padding(16.dp),
            contentAlignment = Alignment.Center
        ) {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier.fillMaxWidth().padding(20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Icon(
                        imageVector = Icons.Outlined.CloudOff,
                        contentDescription = null,
                        modifier = Modifier.size(40.dp),
                        tint = MaterialTheme.colorScheme.error
                    )
                    Text(
                        text = Txt(MessageKey.business_delivery_zones_error_title),
                        style = MaterialTheme.typography.titleSmall
                    )
                    Text(
                        text = Txt(MessageKey.business_delivery_zones_error_subtitle),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Button(onClick = onRetry) {
                        Text(text = Txt(MessageKey.business_delivery_zones_error_retry))
                    }
                }
            }
        }
    }

    @Composable
    private fun MissingBusinessState() {
        Box(
            modifier = Modifier.fillMaxSize().padding(16.dp),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = Txt(MessageKey.business_delivery_zones_missing_business),
                style = MaterialTheme.typography.bodyLarge
            )
        }
    }

    @Composable
    private fun PlayServicesFallbackCard(modifier: Modifier = Modifier) {
        Box(modifier = modifier.padding(24.dp), contentAlignment = Alignment.Center) {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier.fillMaxWidth().padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Icon(
                        imageVector = Icons.Outlined.CloudOff,
                        contentDescription = null,
                        modifier = Modifier.size(72.dp),
                        tint = MaterialTheme.colorScheme.onErrorContainer
                    )
                    Text(
                        text = Txt(MessageKey.business_delivery_zones_play_services_title),
                        style = MaterialTheme.typography.titleMedium
                    )
                    Text(
                        text = Txt(MessageKey.business_delivery_zones_play_services_subtitle),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Button(onClick = { /* CTA Play Store — abrir intent en split 2 */ }) {
                        Text(text = Txt(MessageKey.business_delivery_zones_play_services_install))
                    }
                    TextButton(onClick = { goBack() }) {
                        Text(text = Txt(MessageKey.business_delivery_zones_play_services_back))
                    }
                }
            }
        }
    }

    @Composable
    private fun ZonesList(
        zones: List<DeliveryZoneDTO>,
        selectedZoneId: String?,
        isDark: Boolean,
        onZoneTap: (String) -> Unit
    ) {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 8.dp)
        ) {
            items(items = zones, key = { it.id }) { zone ->
                val index = zones.indexOf(zone)
                val color = ZonesPalette.colorAt(index)
                ZoneRow(
                    zone = zone,
                    chipColor = color.fillFor(isDark),
                    isSelected = zone.id == selectedZoneId,
                    onClick = { onZoneTap(zone.id) }
                )
            }
        }
    }

    @Composable
    private fun ZoneRow(
        zone: DeliveryZoneDTO,
        chipColor: Color,
        isSelected: Boolean,
        onClick: () -> Unit
    ) {
        val backgroundColor = if (isSelected) {
            MaterialTheme.colorScheme.primaryContainer
        } else {
            MaterialTheme.colorScheme.surface
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 64.dp)
                .background(backgroundColor)
                .clickable(onClick = onClick)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            // Touch target 48dp envuelve al chip visual de 24dp (CA-8-L).
            Box(
                modifier = Modifier.size(48.dp),
                contentAlignment = Alignment.Center
            ) {
                Box(
                    modifier = Modifier
                        .size(24.dp)
                        .clip(CircleShape)
                        .background(chipColor)
                )
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = zone.name,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1
                )
                if (zone.estimatedMinutes != null) {
                    Text(
                        text = "~${zone.estimatedMinutes} min",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            Text(
                text = formatZoneCost(zone.costCents),
                style = MaterialTheme.typography.titleSmall
            )
        }
    }
}

/**
 * Centro de fallback para el mapa cuando el negocio no tiene direccion en perfil
 * (UX seccion 11): Obelisco CABA, lat=-34.6037, lng=-58.3816.
 */
private val OBELISCO_CABA: Pair<Double, Double> = -34.6037 to -58.3816

/**
 * Formatea el costo de la zona segun convenciones argentinas (UX seccion 12):
 * - 0 -> "Gratis"
 * - otro -> "$ 1.500" (separador miles con punto, sin decimales por default)
 *
 * Visible solo para tests dentro del mismo modulo.
 */
internal fun formatZoneCost(costCents: Long): String {
    if (costCents == 0L) return "Gratis"
    val pesos = costCents / 100
    val formatted = pesos.toString()
        .reversed()
        .chunked(3)
        .joinToString(".")
        .reversed()
    return "$ $formatted"
}
