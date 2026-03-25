package ui.util

import androidx.compose.runtime.Composable

/**
 * Retorna una función que abre la app de mapas del sistema con la dirección dada.
 * La función retorna true si se pudo abrir, false si no hay app de mapas disponible.
 */
@Composable
expect fun rememberOpenExternalMap(): (address: String) -> Boolean
