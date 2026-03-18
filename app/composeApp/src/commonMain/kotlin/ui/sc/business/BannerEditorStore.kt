package ui.sc.business

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

data class BannerDraft(
    val id: String? = null,
    val title: String = "",
    val text: String = "",
    val imageUrl: String = "",
    val position: String = "home",
    val active: Boolean = true
)

object BannerEditorStore {
    private val mutableDraft = MutableStateFlow<BannerDraft?>(null)

    val draft: StateFlow<BannerDraft?> = mutableDraft.asStateFlow()

    fun setDraft(draft: BannerDraft?) {
        mutableDraft.value = draft
    }

    fun update(transform: (BannerDraft?) -> BannerDraft?) {
        mutableDraft.update(transform)
    }

    fun clear() {
        mutableDraft.value = null
    }
}
