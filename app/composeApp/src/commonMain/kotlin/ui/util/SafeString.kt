@file:Suppress("FunctionName")

package ui.util

import androidx.compose.runtime.Composable
import org.jetbrains.compose.resources.StringResource

internal const val SAFE_STRING_DEPRECATION_MESSAGE = "Usar resString(...) con fb(\"...\") para fallbacks ASCII-safe"

/**
 * Wrapper legado que delega en [resString].
 * Mantener hasta migrar todos los consumidores a fallbacks explícitos con [fb].
 */
@Deprecated(SAFE_STRING_DEPRECATION_MESSAGE)
@Composable
fun safeString(
    @Suppress("UNUSED_PARAMETER") id: StringResource,
    fallback: String = RES_ERROR_PREFIX + fb("Texto no disponible"),
): String = resString(fallbackAsciiSafe = fallback)
