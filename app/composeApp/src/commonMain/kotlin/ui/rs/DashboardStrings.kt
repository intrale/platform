@file:OptIn(InternalResourceApi::class)

package ui.rs

import kotlin.OptIn
import kotlin.collections.setOf
import org.jetbrains.compose.resources.InternalResourceApi
import org.jetbrains.compose.resources.ResourceItem
import org.jetbrains.compose.resources.StringResource

private const val RESOURCE_PREFIX = "composeResources/ui.rs/"

val dashboard: StringResource by lazy {
    StringResource(
        "string:dashboard",
        "dashboard",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 543, 37)
        )
    )
}

val semi_circular_menu_open: StringResource by lazy {
    StringResource(
        "string:semi_circular_menu_open",
        "semi_circular_menu_open",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 3077, 63)
        )
    )
}

val semi_circular_menu_close: StringResource by lazy {
    StringResource(
        "string:semi_circular_menu_close",
        "semi_circular_menu_close",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 3012, 64)
        )
    )
}

val dashboard_menu_hint: StringResource by lazy {
    StringResource(
        "string:dashboard_menu_hint",
        "dashboard_menu_hint",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 435, 107)
        )
    )
}

val buttons_preview: StringResource by lazy {
    StringResource(
        "string:buttons_preview",
        "buttons_preview",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 236, 55)
        )
    )
}

val change_password: StringResource by lazy {
    StringResource(
        "string:change_password",
        "change_password",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 292, 51)
        )
    )
}

val two_factor_setup: StringResource by lazy {
    StringResource(
        "string:two_factor_setup",
        "two_factor_setup",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 3404, 76)
        )
    )
}

val two_factor_verify: StringResource by lazy {
    StringResource(
        "string:two_factor_verify",
        "two_factor_verify",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 3481, 77)
        )
    )
}

val register_business: StringResource by lazy {
    StringResource(
        "string:register_business",
        "register_business",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 2352, 49)
        )
    )
}

val request_join_business: StringResource by lazy {
    StringResource(
        "string:request_join_business",
        "request_join_business",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 2666, 53)
        )
    )
}

val review_business: StringResource by lazy {
    StringResource(
        "string:review_business",
        "review_business",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 2720, 79)
        )
    )
}

val review_join_business: StringResource by lazy {
    StringResource(
        "string:review_join_business",
        "review_join_business",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 2900, 68)
        )
    )
}

val register_saler: StringResource by lazy {
    StringResource(
        "string:register_saler",
        "register_saler",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 2477, 46)
        )
    )
}

val logout: StringResource by lazy {
    StringResource(
        "string:logout",
        "logout",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 2019, 22)
        )
    )
}
