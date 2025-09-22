@file:Suppress("FunctionName")

package ui.util

import androidx.compose.runtime.Composable
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.jetbrains.compose.resources.StringResource
import org.jetbrains.compose.resources.stringResource
import org.kodein.log.Logger
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

private val safeStringLogger: Logger = LoggerFactory.default.newLogger("ui.util", "SafeString")

private val BASE64_REGEX = Regex("^[A-Za-z0-9+/]+={0,2}$")

@OptIn(ExperimentalResourceApi::class)
@Composable
fun safeString(id: StringResource, fallback: String = "—"): String =
    runCatching { stringResource(id) }
        .onFailure { error ->
            safeStringLogger.error(error) { "[RES_FALLBACK] fallo al cargar id=$id" }
        }
        .getOrElse { fallback }

/**
 * Decodifica una cadena solo si cumple claramente con el formato Base64.
 * Si la validación o la decodificación fallan, devuelve el valor original.
 */
@OptIn(ExperimentalEncodingApi::class)
fun decodeIfBase64OrReturn(original: String): String {
    val candidate = original.trim()
    if (candidate.isEmpty()) return candidate
    if (candidate.contains('\n') || candidate.contains('\r')) return original
    if (candidate.length % 4 != 0) return original
    if (!BASE64_REGEX.matches(candidate)) return original

    return runCatching {
        Base64.decode(candidate).decodeToString()
    }.getOrElse { original }
}

