package ui.util

import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import org.jetbrains.compose.resources.StringResource
import org.jetbrains.compose.resources.stringResource

@Composable
actual fun resString(
    androidId: Int?,
    composeId: StringResource?,
    fallbackAsciiSafe: String,
): String {
    val fallback = fallbackAsciiSafe
    val context = LocalContext.current

    var androidFailure: Throwable? = null
    if (androidId != null) {
        runCatching { context.getString(androidId) }
            .onSuccess { return it }
            .onFailure { error -> androidFailure = error }
    }

    var composeFailure: Throwable? = null
    if (composeId != null) {
        runCatching { stringResource(composeId) }
            .onSuccess { return it }
            .onFailure { error -> composeFailure = error }
    }

    composeFailure?.let { failure ->
        androidFailure?.let(failure::addSuppressed)
    }

    val identifier = buildString {
        append("androidId=")
        append(androidId ?: "null")
        append(' ')
        append("composeId=")
        append(composeId ?: "null")
    }

    val error = composeFailure ?: androidFailure
    return if (error != null) {
        logFallback(identifier, fallback, error)
    } else {
        logFallback(identifier, fallback, null)
    }
}
