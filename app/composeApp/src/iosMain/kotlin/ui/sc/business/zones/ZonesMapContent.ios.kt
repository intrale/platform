package ui.sc.business.zones

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ar.com.intrale.shared.business.DeliveryZoneDTO

/**
 * Actual iOS — placeholder. Las zonas de delivery con mapa interactivo son
 * feature Android del flavor business (#2420). iOS muestra texto informativo
 * para no romper la compilacion del target. Cuando aterrice el equivalente iOS
 * (post split 2 #2421) se reemplaza por MapKit/SwiftUI bridging.
 */
@Composable
actual fun ZonesMapContent(
    zones: List<DeliveryZoneDTO>,
    selectedZoneId: String?,
    isDarkTheme: Boolean,
    onZoneTap: (String) -> Unit,
    fallbackCenter: Pair<Double, Double>,
    modifier: Modifier
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = "Mapa disponible solo en Android (Intrale Negocios)",
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(24.dp)
        )
    }
}

@Composable
actual fun isMapAvailable(): Boolean = false
