package ext.location

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember

/**
 * Stub Web/Wasm — el flavor Web no soporta el flujo de verificación de
 * zona en esta hija (issue #2422 alcance Android-only). El navegador
 * tiene su propia API de geolocalización, pero está fuera de scope.
 */
@Composable
actual fun rememberCoarseLocationPermissionLauncher(
    onResult: (granted: Boolean) -> Unit
): () -> Unit {
    return remember(onResult) { { onResult(false) } }
}
