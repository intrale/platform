package ar.com.intrale.strings.model

/**
 * Claves type-safe para todos los textos de la app.
 * Agregá aquí las que vayas necesitando.
 */
@Suppress("EnumEntryName")
enum class MessageKey {
    app_name,
    login_title,
    login_subtitle,
    login_button,
    error_generic,
    login_error_credentials,
    login_change_password_required,
    login_change_password_title,
    login_change_password_description,
    login_user_icon_content_description,
    login_password_icon_content_description,
    signup,
    register_business,
    signup_delivery,
    password_recovery,
    confirm_password_recovery,
    username,
    password,
    new_password,
    name,
    family_name,
    login_email_placeholder,
    login_password_placeholder,
    login_new_password_placeholder,
    login_name_placeholder,
    login_family_name_placeholder,
    validation_enter_email,
    validation_enter_valid_email,
    validation_enter_password,
    validation_min_length,
    validation_enter_new_password,
    validation_enter_name,
    validation_enter_family_name,
}
