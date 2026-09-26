// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import ui.App

fun main() = application {
    Window(
        onCloseRequest = ::exitApplication,
        title = "Intrale",
    ) {
        App()
    }
}