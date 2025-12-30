package ui.sc.business

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

object CategoryEditorStore {
    private val mutableDraft = MutableStateFlow<CategoryDraft?>(null)

    val draft: StateFlow<CategoryDraft?> = mutableDraft.asStateFlow()

    fun setDraft(draft: CategoryDraft?) {
        mutableDraft.value = draft
    }

    fun update(transform: (CategoryDraft?) -> CategoryDraft?) {
        mutableDraft.update(transform)
    }

    fun clear() {
        mutableDraft.value = null
    }
}
