package ui.util

import androidx.compose.runtime.Composable
import org.jetbrains.compose.resources.StringResource
import org.jetbrains.compose.resources.stringResource

@Composable
actual fun resString(
    androidId: Int?,
    composeId: StringResource?,
    fallbackAsciiSafe: String,
): String {
    val fallback = fallbackAsciiSafe

    var composeFailure: Throwable? = null
    if (composeId != null) {
        runCatching { stringResource(composeId) }
            .onSuccess { return it }
            .onFailure { error -> composeFailure = error }
    }

    val identifier = buildString {
        append("androidId=")
        append(androidId ?: "null")
        append(' ')
        append("composeId=")
        append(composeId ?: "null")
    }

    return if (composeFailure != null) {
        logFallback(identifier, fallback, composeFailure)
    } else {
        logFallback(identifier, fallback, null)
    }
}
