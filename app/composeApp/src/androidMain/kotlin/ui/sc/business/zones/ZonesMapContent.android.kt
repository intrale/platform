package ui.sc.business.zones

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import ar.com.intrale.shared.business.DeliveryZoneDTO
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.MapStyleOptions
import com.google.maps.android.compose.CameraPositionState
import com.google.maps.android.compose.GoogleMap
import com.google.maps.android.compose.MapProperties
import com.google.maps.android.compose.MapUiSettings
import com.google.maps.android.compose.Polygon
import com.google.maps.android.compose.rememberCameraPositionState
import ui.th.ZonesPalette
import ui.th.fillFor
import ui.th.strokeFor

/**
 * Actual de Android para `ZonesMapContent` (#2420 split 1).
 *
 * - Detecta Google Play Services (CA-7-L). Si no esta disponible, renderiza
 *   un fallback de texto que el screen wrapper interpreta para mostrar el card
 *   de instalar Play Services. Para mantener este actual minimo, el fallback
 *   completo (con CTAs e iconos) lo arma `ZonesListScreen` consultando
 *   `isGooglePlayServicesAvailable()` por separado.
 * - Aplica `map_style_dark.json` cuando isDarkTheme=true (CA-6-L).
 * - Renderiza polygons con la paleta de `ZonesPalette` (CA-4-L).
 * - El tap en un polygon dispara `onZoneTap(zoneId)` (CA-3-L).
 *
 * NOTA: Los flavors `client`/`delivery` cargan el SDK pero no llaman a este
 * composable (ZonesListScreen solo se registra para BUSINESS en DIManager).
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
    val context = LocalContext.current
    val playServicesOk = remember {
        GoogleApiAvailability.getInstance()
            .isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
    }

    if (!playServicesOk) {
        // El screen wrapper detecta este caso por separado y renderiza el
        // fallback completo (CA-7-L). Aca solo dejamos un placeholder visible
        // para que el composable no quede vacio si por algun motivo se renderea.
        Box(
            modifier = modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.surfaceVariant),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = "Google Play Services requerido",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(16.dp)
            )
        }
        return
    }

    // Resolver el R.raw.map_style_dark dinamicamente — el recurso vive solo en
    // el flavor business (src/business/res/raw/map_style_dark.json). Para que el
    // codigo en androidMain compile en cualquier flavor, lo resolvemos por nombre
    // y hacemos null-safe el resultado.
    val mapStyleResId = remember(isDarkTheme) {
        if (!isDarkTheme) return@remember 0
        runCatching {
            context.resources.getIdentifier("map_style_dark", "raw", context.packageName)
        }.getOrDefault(0)
    }
    val mapStyle = remember(mapStyleResId) {
        if (mapStyleResId != 0) {
            runCatching { MapStyleOptions.loadRawResourceStyle(context, mapStyleResId) }.getOrNull()
        } else null
    }

    val initialLatLng = remember { LatLng(fallbackCenter.first, fallbackCenter.second) }
    val cameraPositionState: CameraPositionState = rememberCameraPositionState {
        position = com.google.android.gms.maps.model.CameraPosition.fromLatLngZoom(initialLatLng, 13f)
    }

    val mapProperties by remember(mapStyle) {
        mutableStateOf(
            MapProperties(
                isMyLocationEnabled = false,
                mapStyleOptions = mapStyle
            )
        )
    }
    val uiSettings = remember {
        MapUiSettings(
            zoomControlsEnabled = true,
            myLocationButtonEnabled = false,
            mapToolbarEnabled = false
        )
    }

    // Cuando cambia la zona seleccionada, animamos la camara al centro de los puntos.
    LaunchedEffect(selectedZoneId) {
        val target = zones.firstOrNull { it.id == selectedZoneId } ?: return@LaunchedEffect
        if (target.points.isEmpty()) return@LaunchedEffect
        val avgLat = target.points.map { it.latitude }.average()
        val avgLng = target.points.map { it.longitude }.average()
        cameraPositionState.position = com.google.android.gms.maps.model.CameraPosition
            .fromLatLngZoom(LatLng(avgLat, avgLng), 14f)
    }

    Box(modifier = modifier) {
        GoogleMap(
            modifier = Modifier.fillMaxSize(),
            cameraPositionState = cameraPositionState,
            properties = mapProperties,
            uiSettings = uiSettings
        ) {
            zones.forEachIndexed { index, zone ->
                if (zone.points.size < 3) return@forEachIndexed
                val color = ZonesPalette.colorAt(index)
                Polygon(
                    points = zone.points.map { LatLng(it.latitude, it.longitude) },
                    fillColor = color.fillFor(isDarkTheme),
                    strokeColor = color.strokeFor(isDarkTheme),
                    strokeWidth = if (zone.id == selectedZoneId) 8f else 4f,
                    clickable = true,
                    onClick = { onZoneTap(zone.id) },
                    zIndex = if (zone.id == selectedZoneId) 1f else 0f
                )
            }
        }
    }
}

@Composable
actual fun isMapAvailable(): Boolean {
    val context = LocalContext.current
    return remember {
        GoogleApiAvailability.getInstance()
            .isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
    }
}
