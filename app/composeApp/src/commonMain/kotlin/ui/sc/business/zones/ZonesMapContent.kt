package ui.sc.business.zones

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import ar.com.intrale.shared.business.DeliveryZoneDTO

/**
 * Composable que renderea el mapa con polygons de zonas — split 1 #2420.
 *
 * `expect`: en commonMain solo declara la firma (multiplatform).
 *
 * `actual` por target:
 * - androidBusiness (con maps-compose) -> renderiza GoogleMap con polygons,
 *   aplica map_style_dark.json en dark mode, detecta Google Play Services.
 * - androidClient/Delivery -> NO incluye el SDK (split intencional, CA-10-L).
 *   Por eso vive en androidBusiness, no en androidMain.
 * - desktop/ios/wasmJs -> placeholder visual ("Mapa solo disponible en Android").
 *
 * Nota OBS-2 del Guru: usamos expect/actual para que el ViewModel quede en
 * commonMain y solo el composable del mapa se especialice por plataforma.
 */
@Composable
expect fun ZonesMapContent(
    zones: List<DeliveryZoneDTO>,
    selectedZoneId: String?,
    isDarkTheme: Boolean,
    onZoneTap: (String) -> Unit,
    fallbackCenter: Pair<Double, Double>,
    modifier: Modifier
)

/**
 * Indica si el target actual puede mostrar el mapa interactivo (CA-7-L).
 *
 * - Android (con Google Play Services) -> true.
 * - Android (sin Play Services o emulador sin GMS) -> false.
 * - desktop / iOS / wasmJs -> false (placeholder).
 *
 * El screen wrapper usa este flag para decidir entre el mapa y el card de
 * fallback "Necesitas Google Play Services".
 */
@Composable
expect fun isMapAvailable(): Boolean
