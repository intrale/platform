package ui.util

/**
 * Obtiene el identificador entero de un recurso de strings nativo de Android.
 *
 * @param name Nombre de la clave definida en `strings.xml` (por ejemplo, `"two_factor_setup"`).
 * @return Identificador del recurso o `null` si no existe o si la plataforma no provee recursos Android.
 */
expect fun androidStringId(name: String): Int?
