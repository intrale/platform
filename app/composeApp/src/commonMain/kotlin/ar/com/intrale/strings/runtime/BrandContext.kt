package ar.com.intrale.strings.runtime

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember

/**
 * Stub: por ahora "default".
 * Más adelante lo conectamos a BuildKonfig o a tu propiedad -PbrandId.
 */
@Composable
fun currentBrand(): String = remember { "default" }
