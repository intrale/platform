// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ar.com.intrale.strings.runtime

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import ar.com.intrale.BuildKonfig

/**
 * Stub: por ahora "default".
 * Más adelante lo conectamos a BuildKonfig o a tu propiedad -PbrandId.
 */
@Composable
fun currentBrand(): String = remember { BuildKonfig.BUSINESS.lowercase() }
