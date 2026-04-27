package ext.location

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember

/**
 * Implementación Android de [rememberCoarseLocationPermissionLauncher].
 *
 * Usa el contrato oficial de AndroidX
 * (`ActivityResultContracts.RequestPermission`) que muestra el diálogo
 * nativo del sistema y devuelve `true`/`false` según la elección del
 * usuario.
 *
 * Privacidad / Security A05:
 * - Solo se solicita `ACCESS_COARSE_LOCATION`. NO se pide `FINE_LOCATION`.
 * - El rationale (`AddressCheckRationaleSheet`) DEBE haberse mostrado
 *   antes de invocar el lambda devuelto por esta función.
 */
@Composable
actual fun rememberCoarseLocationPermissionLauncher(
    onResult: (granted: Boolean) -> Unit
): () -> Unit {
    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
        onResult = onResult,
    )
    return remember(launcher) {
        { launcher.launch(Manifest.permission.ACCESS_COARSE_LOCATION) }
    }
}
