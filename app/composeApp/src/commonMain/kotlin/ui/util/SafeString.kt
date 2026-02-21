@file:Suppress("FunctionName")

package ui.util

import androidx.compose.runtime.Composable
import org.jetbrains.compose.resources.StringResource

internal const val SAFE_STRING_DEPRECATION_MESSAGE = "Usar Txt(MessageKey, params)"

/**
 * Wrapper legado — deprecado con ERROR para forzar migración a [Txt].
 */
@Deprecated(
    message = SAFE_STRING_DEPRECATION_MESSAGE,
    replaceWith = ReplaceWith("Txt(key, params)", "ar.com.intrale.strings.Txt"),
    level = DeprecationLevel.ERROR,
)
@Composable
fun safeString(
    @Suppress("UNUSED_PARAMETER") id: StringResource,
    @Suppress("UNUSED_PARAMETER") fallback: String = RES_ERROR_PREFIX + fb("Texto no disponible"),
): String = error("Reemplazar por Txt(MessageKey)")
