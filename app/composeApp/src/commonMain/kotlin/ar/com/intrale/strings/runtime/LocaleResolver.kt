package ar.com.intrale.strings.runtime

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember

/**
 * Muy simple: devolvemos "es" por ahora.
 * Luego si querés, hacé expect/actual para leer idioma real por plataforma.
 */
@Composable
fun currentLang(): String = remember { "es" }
