package ui.util

import androidx.compose.runtime.Composable

/**
 * Retorna una función que abre una URL en el navegador del sistema.
 * Usada para abrir pasarelas de pago externas (Mercado Pago Checkout Pro, etc.).
 * La función retorna true si se pudo abrir, false si falló.
 */
@Composable
expect fun rememberOpenExternalUrl(): (url: String) -> Boolean
