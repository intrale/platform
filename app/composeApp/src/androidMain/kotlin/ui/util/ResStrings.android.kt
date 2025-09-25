package ui.util

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import org.jetbrains.compose.resources.StringResource
import org.jetbrains.compose.resources.stringResource as composeStringResource

@Composable
actual fun resString(
    androidId: Int?,
    composeId: StringResource?,
    fallbackAsciiSafe: String,
): String {
    val context: Context = LocalContext.current
    val identifier = "androidId=$androidId composeId=$composeId"

    androidId?.let { id ->
        return resolveOrFallback(
            identifier = identifier,
            resolver = { context.getString(id) },
            fallback = fallbackAsciiSafe,
        )
    }

    composeId?.let { cid ->
        return runCatching { composeStringResource(cid) }
            .getOrElse { error ->
                logFallback(identifier, fallbackAsciiSafe, error)
            }
    }

    return logFallback(identifier, fallbackAsciiSafe)
}
