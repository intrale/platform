// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ui.cp.inputs

data class InputState(
    var fieldName: String,
    var isValid: Boolean = true,
    var details: String = ""
)