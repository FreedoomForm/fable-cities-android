package android.app
import android.os.Bundle
open class Activity : android.content.Context() {
    var window: Window = Window()
    open fun setContentView(v: android.view.View): Unit = Unit
    open fun runOnUiThread(a: Runnable): Unit = Unit
    open fun onCreate(b: Bundle?): Unit = Unit
    open fun onPause(): Unit = Unit
    open fun onResume(): Unit = Unit
    open fun onDestroy(): Unit = Unit
    open fun onBackPressed(): Unit = Unit
    open fun requestWindowFeature(f: Int): Boolean = true
}
typealias Window = android.view.Window
