// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ui.util

import android.content.res.Resources
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
@Composable
actual fun resString(
    androidId: Int?,
    fallbackAsciiSafe: String,
): String {
    // Intentamos resolver recursos Android si están disponibles
    val ctx = runCatching { LocalContext.current }.getOrNull()
    val resources: Resources? = ctx?.resources
    if (androidId != null && resources != null) {
        runCatching {
            return resources.getText(androidId).toString()
        }
    }

    // Fallback definitivo (ASCII-safe)
    return fallbackAsciiSafe
}
