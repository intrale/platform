@file:OptIn(InternalResourceApi::class)

package ui.rs

import kotlin.OptIn
import kotlin.collections.setOf
import org.jetbrains.compose.resources.InternalResourceApi
import org.jetbrains.compose.resources.ResourceItem
import org.jetbrains.compose.resources.StringResource

private const val RESOURCE_PREFIX = "composeResources/ui.rs/"

val personalization_title: StringResource by lazy {
    StringResource(
        "string:personalization_title",
        "personalization_title",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 2960, 65)
        )
    )
}

val personalization_panel: StringResource by lazy {
    StringResource(
        "string:personalization_panel",
        "personalization_panel",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 2548, 53)
        )
    )
}

val personalization_description: StringResource by lazy {
    StringResource(
        "string:personalization_description",
        "personalization_description",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 2460, 87)
        )
    )
}

val personalization_access_denied: StringResource by lazy {
    StringResource(
        "string:personalization_access_denied",
        "personalization_access_denied",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 2297, 101)
        )
    )
}

val personalization_business_context: StringResource by lazy {
    StringResource(
        "string:personalization_business_context",
        "personalization_business_context",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 2399, 60)
        )
    )
}

val personalization_section_pending: StringResource by lazy {
    StringResource(
        "string:personalization_section_pending",
        "personalization_section_pending",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 2765, 71)
        )
    )
}

val personalization_section_colors: StringResource by lazy {
    StringResource(
        "string:personalization_section_colors",
        "personalization_section_colors",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 2663, 50)
        )
    )
}

val personalization_section_typography: StringResource by lazy {
    StringResource(
        "string:personalization_section_typography",
        "personalization_section_typography",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 2901, 58)
        )
    )
}

val personalization_section_images: StringResource by lazy {
    StringResource(
        "string:personalization_section_images",
        "personalization_section_images",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 2714, 50)
        )
    )
}

val personalization_section_app_icon: StringResource by lazy {
    StringResource(
        "string:personalization_section_app_icon",
        "personalization_section_app_icon",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 2602, 60)
        )
    )
}

val personalization_section_preview: StringResource by lazy {
    StringResource(
        "string:personalization_section_preview",
        "personalization_section_preview",
        setOf(
            ResourceItem(setOf(), "${RESOURCE_PREFIX}values/strings.commonMain.cvr", 2837, 63)
        )
    )
}
