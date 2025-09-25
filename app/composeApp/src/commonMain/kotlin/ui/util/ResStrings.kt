package ui.util

import androidx.compose.runtime.Composable
import org.jetbrains.compose.resources.StringResource
import org.kodein.log.Logger
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

const val RES_ERROR_PREFIX = "⚠ "

private val resStringLogger: Logger = LoggerFactory.default.newLogger("ui.util", "ResStrings")

private object ResStringFallbackMetrics {
    private var fallbackCount: Int = 0

    fun registerFallback(): Int {
        fallbackCount += 1
        return fallbackCount
    }
}

@Composable
expect fun resString(
    androidId: Int? = null,
    composeId: StringResource? = null,
    fallbackAsciiSafe: String,
): String

fun fb(asciiSafe: String): String =
    buildString(asciiSafe.length) {
        asciiSafe.forEach { ch ->
            if (ch.code in 0..0x7F) {
                append(ch)
            } else {
                append("\\u")
                append(ch.code.toString(16).uppercase().padStart(4, '0'))
            }
        }
    }


internal fun resolveOrFallback(
    identifier: String,
    resolver: () -> String,
    fallback: String,
    onFailure: (Throwable) -> Unit = {},
): String {
    return runCatching { resolver() }
        .getOrElse { error ->
            onFailure(error)
            logFallback(identifier, fallback, error)
        }
}

internal fun logFallback(
    identifier: String,
    fallback: String,
    error: Throwable? = null,
): String {
    val total = ResStringFallbackMetrics.registerFallback()
    val sanitizedFallback = fallback.sanitizeForLog()
    val logMessage = "[RES_FALLBACK] $identifier total=$total fallback=\"$sanitizedFallback\""
    if (error != null) {
        runCatching {
            resStringLogger.error(error) { logMessage }
        }
    } else {
        runCatching {
            resStringLogger.warning { logMessage }
        }
    }
    return fallback
}

internal fun String.sanitizeForLog(): String {
    return this
        .removePrefix(RES_ERROR_PREFIX)
        .filter { it.code in 32..126 }
        .trim()
}
