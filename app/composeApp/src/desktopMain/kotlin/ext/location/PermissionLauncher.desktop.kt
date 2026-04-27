package ext.location

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember

/**
 * Stub Desktop/JVM — el flavor Desktop no soporta el flujo de
 * verificación de zona en esta hija (issue #2422 alcance Android-only).
 */
@Composable
actual fun rememberCoarseLocationPermissionLauncher(
    onResult: (granted: Boolean) -> Unit
): () -> Unit {
    return remember(onResult) { { onResult(false) } }
}
