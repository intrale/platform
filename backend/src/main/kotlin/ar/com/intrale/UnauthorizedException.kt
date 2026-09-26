// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

    package ar.com.intrale

import io.ktor.http.HttpStatusCode

class UnauthorizedException() : Response(statusCode = HttpStatusCode.Unauthorized) {
}
