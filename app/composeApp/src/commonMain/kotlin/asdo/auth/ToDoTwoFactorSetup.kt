// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.auth

interface ToDoTwoFactorSetup {
    suspend fun execute(): Result<DoTwoFactorSetupResult>
}

