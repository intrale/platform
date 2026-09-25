// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ar.com.intrale

import io.ktor.http.HttpStatusCode

class NoContentResponse : Response(statusCode = HttpStatusCode.NoContent)
