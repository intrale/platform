package ext.location

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember

/**
 * Stub iOS — el flavor iOS no usa el flujo de verificación de zona en
 * esta hija (issue #2422 alcance Android-only). Si la pantalla intentara
 * abrirse en iOS por error, el lambda devuelto resuelve sin permiso y
 * el ViewModel cae al fallback de ingreso manual.
 */
@Composable
actual fun rememberCoarseLocationPermissionLauncher(
    onResult: (granted: Boolean) -> Unit
): () -> Unit {
    return remember(onResult) { { onResult(false) } }
}
