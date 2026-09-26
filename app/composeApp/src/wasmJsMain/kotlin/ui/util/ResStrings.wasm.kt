// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ui.util

import androidx.compose.runtime.Composable
@Composable
actual fun resString(
    androidId: Int?,
    fallbackAsciiSafe: String,
): String = fallbackAsciiSafe
