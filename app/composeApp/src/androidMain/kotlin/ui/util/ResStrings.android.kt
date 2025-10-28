package ui.util

import android.content.res.Resources
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
    // 1) Compose resources (sin try/catch)
    if (composeId != null) {
        return stringResource(composeId)
    }

    // 2) R.string (esto NO es composable; podemos protegerlo)
    val ctx = runCatching { LocalContext.current }.getOrNull()
    val resources: Resources? = ctx?.resources
    if (androidId != null && resources != null) {
        runCatching {
            return resources.getString(androidId)
        }
        // si falla, seguimos al fallback
    }

    // 3) Fallback definitivo (ASCII-safe)
    return fallbackAsciiSafe
}
