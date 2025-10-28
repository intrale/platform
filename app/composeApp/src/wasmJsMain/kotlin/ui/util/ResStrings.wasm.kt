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
    return when {
        composeId != null -> stringResource(composeId)
        else -> fallbackAsciiSafe
    }
}
