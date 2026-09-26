// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ar.com.intrale

interface Function {
    suspend fun execute(business: String, function: String, headers: Map<String, String>, textBody:String): Response
}