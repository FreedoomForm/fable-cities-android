package android.widget
open class FrameLayout(context: Any?) : android.view.View(context) {
    open fun addView(v: android.view.View, params: LayoutParams?): Unit = Unit
    class LayoutParams(val width: Int = 0, val height: Int = 0) {
        companion object { const val MATCH_PARENT = -1; const val WRAP_CONTENT = -2 }
    }
}
class Toast private constructor() {
    companion object {
        const val LENGTH_SHORT = 0
        fun makeText(c: android.content.Context, msg: String, dur: Int): Toast = Toast()
    }
    fun show(): Unit = Unit
}
