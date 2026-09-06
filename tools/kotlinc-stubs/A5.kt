package android.view
import android.graphics.Canvas
open class View(context: Any?) {
    companion object {
        const val LAYER_TYPE_HARDWARE = 2
        const val SYSTEM_UI_FLAG_FULLSCREEN = 4
        const val SYSTEM_UI_FLAG_HIDE_NAVIGATION = 2
        const val SYSTEM_UI_FLAG_IMMERSIVE_STICKY = 4096
        const val SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN = 1024
        const val SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION = 512
        const val SYSTEM_UI_FLAG_LAYOUT_STABLE = 256
    }
    fun setLayerType(type: Int, factory: Any?): Unit = Unit
    fun post(action: Runnable): Boolean = true
    fun postDelayed(action: Runnable, delay: Long): Boolean = true
    fun postOnAnimation(action: Runnable): Unit = Unit
    fun invalidate(): Unit = Unit
    val width: Int get() = 0
    val height: Int get() = 0
    val context: android.content.Context get() = android.content.Context()
    val decorView: View = this
    var systemUiVisibility: Int
        get() = 0
        set(v: Int) {}
    protected open fun onSizeChanged(w: Int, h: Int, ow: Int, oh: Int): Unit = Unit
    open fun onTouchEvent(e: MotionEvent): Boolean = false
    protected open fun onDraw(c: Canvas): Unit = Unit
}
class MotionEvent {
    companion object {
        const val ACTION_DOWN = 0
        const val ACTION_UP = 1
        const val ACTION_MOVE = 2
        const val ACTION_CANCEL = 3
        const val ACTION_POINTER_DOWN = 5
        const val ACTION_POINTER_UP = 6
    }
    val actionMasked: Int = 0
    val x: Float = 0f
    val y: Float = 0f
    val pointerCount: Int = 1
    fun getX(i: Int): Float = 0f
    fun getY(i: Int): Float = 0f
}
class WindowInsets {
    class Type { companion object { fun systemBars(): Int = 0 } }
}
class WindowInsetsController {
    companion object { const val BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE = 2 }
    fun hide(type: Int): Unit = Unit
    var systemBarsBehavior: Int = 0
}
interface WindowManager {
    object LayoutParams {
        const val FLAG_FULLSCREEN = 1024
    }
}
open class Window {
    fun setFlags(flags: Int, mask: Int): Unit = Unit
    val insetsController: WindowInsetsController? = null
    val decorView: View = View(null)
    companion object { const val FEATURE_NO_TITLE = 1 }
}
