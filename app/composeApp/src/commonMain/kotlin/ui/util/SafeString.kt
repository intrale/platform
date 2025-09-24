@file:Suppress("FunctionName")

package ui.util

import androidx.compose.runtime.Composable
import org.jetbrains.compose.resources.StringResource

internal const val SAFE_STRING_DEPRECATION_MESSAGE = "Usar resStringOr(...) con fallback explícito"

/**
 * Wrapper legado que delega en [resStringOr].
 * Mantener hasta migrar todos los consumidores a fallbacks explícitos.
 */
@Deprecated(SAFE_STRING_DEPRECATION_MESSAGE)
@Composable
fun safeString(id: StringResource, fallback: String = "—"): String = resStringOr(id, fallback)

