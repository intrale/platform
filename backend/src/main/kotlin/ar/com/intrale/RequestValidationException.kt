// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ar.com.intrale

import io.ktor.http.HttpStatusCode

class RequestValidationException(val message: String) : Response(statusCode = HttpStatusCode.BadRequest) {
}