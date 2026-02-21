package ar.com.intrale.strings

/**
 * Claves legacy — reemplazadas por [ar.com.intrale.strings.model.MessageKey].
 * (No deprecado directamente porque lo usa StringCatalog internamente;
 * la migración se fuerza via funciones Strings.t() y tr() que SÍ están deprecadas)
 */
enum class StringKey {
    App_Name,
    Login_Title,
    Login_Button,
    Error_Generic,
}
