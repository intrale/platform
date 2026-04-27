package ext.location

import androidx.compose.runtime.Composable

/**
 * Wrapper Compose multiplataforma para solicitar el permiso runtime de
 * ubicación coarse (issue #2422).
 *
 * El contrato:
 * - [rememberCoarseLocationPermissionLauncher] devuelve un lambda. Llamarlo
 *   dispara el diálogo nativo del sistema (Android) o resuelve directamente
 *   con `granted=false` (otras plataformas que no soportan ubicación).
 * - El callback `onResult(granted)` recibe el resultado del usuario una vez
 *   que el OS lo informa.
 *
 * En Android la implementación usa
 * `rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission())`
 * — el rationale (CA-2) DEBE mostrarse antes de invocar el lambda.
 *
 * El permiso solicitado es `ACCESS_COARSE_LOCATION`. NO se solicita
 * `FINE_LOCATION` por motivos de minimización de datos (Security A05/A02).
 */
@Composable
expect fun rememberCoarseLocationPermissionLauncher(
    onResult: (granted: Boolean) -> Unit
): () -> Unit
