// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package asdo.signup

interface ToDoSignUpDelivery { suspend fun execute(business: String, email:String): Result<DoSignUpResult> }
