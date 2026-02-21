package ui.sc.client

data class AddressDraft(
    val id: String? = null,
    val label: String = "",
    val street: String = "",
    val number: String = "",
    val reference: String = "",
    val city: String = "",
    val state: String = "",
    val postalCode: String = "",
    val country: String = "",
    val isDefault: Boolean = false
)
