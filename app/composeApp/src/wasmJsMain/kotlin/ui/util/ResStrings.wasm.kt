package ui.util

import androidx.compose.runtime.Composable
@Composable
actual fun resString(
    androidId: Int?,
    fallbackAsciiSafe: String,
): String = fallbackAsciiSafe
