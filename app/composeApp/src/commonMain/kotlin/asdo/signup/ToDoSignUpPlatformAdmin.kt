// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.signup

interface ToDoSignUpPlatformAdmin { suspend fun execute(email:String): Result<DoSignUpResult> }
