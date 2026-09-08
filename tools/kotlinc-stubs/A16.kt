package android.graphics
class Bitmap {
    val width: Int = 0
    val height: Int = 0
    val byteCount: Int = 0
    enum class Config { ARGB_8888, RGB_565 }
    fun getPixels(pixels: IntArray, offset: Int, stride: Int, x: Int, y: Int, w: Int, h: Int): Unit = Unit
    fun recycle(): Unit = Unit
    fun setPremultiplied(v: Boolean): Unit = Unit
    fun copyPixelsToBuffer(dst: java.nio.Buffer): Unit = Unit
    fun setPixels(pixels: IntArray, offset: Int, stride: Int, x: Int, y: Int, w: Int, h: Int): Unit = Unit
    val rowBytes: Int = 0
    companion object {
        fun createBitmap(w: Int, h: Int, cfg: Config): Bitmap = Bitmap()
        fun createScaledBitmap(src: Bitmap, w: Int, h: Int, filter: Boolean): Bitmap = Bitmap()
    }
}
class Rect
class RectF {
    constructor()
    constructor(l: Float, t: Float, r: Float, b: Float)
    fun set(l: Float, t: Float, r: Float, b: Float): Unit = Unit
    var left: Float = 0f
    var top: Float = 0f
    var right: Float = 0f
    var bottom: Float = 0f
    fun width(): Float = 0f
    fun height(): Float = 0f
}
class PorterDuff { enum class Mode { CLEAR, SRC, SRC_OVER } }
class Canvas {
    constructor()
    constructor(bmp: Bitmap)
    fun drawColor(c: Int, mode: PorterDuff.Mode): Unit = Unit
    fun drawRect(l: Float, t: Float, r: Float, b: Float, p: Paint): Unit = Unit
    fun drawCircle(cx: Float, cy: Float, r: Float, p: Paint): Unit = Unit
    fun drawOval(l: Float, t: Float, r: Float, b: Float, p: Paint): Unit = Unit
    fun drawPath(path: Path, p: Paint): Unit = Unit
    fun rotate(deg: Float, px: Float, py: Float): Unit = Unit
    fun restoreToCount(save: Int): Unit = Unit
    fun drawBitmap(b: Bitmap, l: Float, t: Float, p: Paint): Unit = Unit
    fun drawLine(x0: Float, y0: Float, x1: Float, y1: Float, p: Paint): Unit = Unit
    fun drawRoundRect(l: Float, t: Float, r: Float, b: Float, rx: Float, ry: Float, p: Paint): Unit = Unit
    fun drawRoundRect(r: RectF, rx: Float, ry: Float, p: Paint): Unit = Unit
    fun drawText(t: String, x: Float, y: Float, p: Paint): Unit = Unit
    fun save(): Int = 0
    fun restore(): Unit = Unit
    fun clipRect(l: Float, t: Float, r: Float, b: Float): Boolean = true
    fun clipRect(r: RectF): Boolean = true
    fun scale(sx: Float, sy: Float): Unit = Unit
    fun translate(dx: Float, dy: Float): Unit = Unit
}
class Paint {
    enum class Cap { ROUND, BUTT, SQUARE }
    constructor()
    constructor(flags: Int)
    var color: Int = 0
    var isAntiAlias: Boolean = false
    var isDither: Boolean = false
    var shader: Shader? = null
    var strokeCap: Cap = Cap.BUTT
    var strokeWidth: Float = 1f
    var textSize: Float = 12f
    var style: Style = Style.FILL
    var textAlign: Align = Align.LEFT
    var typeface: Typeface = Typeface.DEFAULT
    enum class Style { FILL, STROKE, FILL_AND_STROKE }
    enum class Align { LEFT, CENTER, RIGHT }
    companion object { val ANTI_ALIAS_FLAG = 1 }
}
object BitmapFactory {
    class Options {
        var inScaled: Boolean = false
        var inPreferredConfig: Bitmap.Config = Bitmap.Config.ARGB_8888
    }
    fun decodeStream(is_: java.io.InputStream?, outPadding: Rect? = null, opts: Options? = null): Bitmap = Bitmap()
}
