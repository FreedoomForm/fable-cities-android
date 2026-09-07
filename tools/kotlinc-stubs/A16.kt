package android.graphics
class Bitmap {
    val width: Int = 0
    val height: Int = 0
    enum class Config { ARGB_8888, RGB_565 }
    fun getPixels(pixels: IntArray, offset: Int, stride: Int, x: Int, y: Int, w: Int, h: Int): Unit = Unit
    fun recycle(): Unit = Unit
    companion object {
        fun createScaledBitmap(src: Bitmap, w: Int, h: Int, filter: Boolean): Bitmap = Bitmap()
    }
}
object BitmapFactory {
    class Options {
        var inScaled: Boolean = false
        var inPreferredConfig: Bitmap.Config = Bitmap.Config.ARGB_8888
    }
    fun decodeStream(is_: java.io.InputStream?, outPadding: android.graphics.Rect?, opts: Options?): Bitmap? = null
}
class Rect
