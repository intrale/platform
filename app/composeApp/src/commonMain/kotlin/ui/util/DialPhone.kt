package ui.util

import androidx.compose.runtime.Composable

/**
 * Retorna una función que abre el marcador del sistema sin iniciar la llamada.
 */
@Composable
expect fun rememberDialPhone(): (phone: String) -> Boolean
