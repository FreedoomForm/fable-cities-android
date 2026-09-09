package com.fablecities.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import com.fablecities.android.worldgen.Heightmap
import android.view.MotionEvent
import android.view.View
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The site's start screen (src/modules/menu/index.js) native port. Shows before the HUD: the
 * player picks the seed (with a hillshaded relief preview from the REAL generator — the same
 * Heightmap the world is built from, so what they see is the land they get), names the city,
 * picks a quality preset, and chooses New city / Demo city — or resumes the saved city.
 *
 * The menu overlays the live GL world (the web's Backdrop animation equivalent): the renderer
 * keeps presenting behind the glass card, so the menu sits on a real, moving city.
 */
class MenuOverlayView(context: Context) : View(context) {

    interface Host {
        /** Dismiss the menu and show the HUD (Resume). */
        fun onMenuResume()
        /** Build a fresh world with the chosen seed + mode, then dismiss the menu. */
        fun onMenuStart(seed: Int, mode: Int, cityName: String)
    }

    var host: Host? = null
    private val gameView: FableCitiesView? = null // set via bind after construction
    var game: FableCitiesView? = null

    // ---- state (menu/index.js STORE_KEY: seed + name persist across sessions) ----
    private val prefs = context.getSharedPreferences("fable_cities_city", Context.MODE_PRIVATE)
    private var seed = prefs.getInt("menuSeed", 1337)
    private var cityName = ""
    private var quality = prefs.getString("qualityName", "high") ?: "high"
    private var phase = 0 // 0 = choose, 1 = building
    private var buildingAt = 0L

    // ---- catalog (menu/index.js QUALITIES) ----
    private val qualities = listOf("low", "medium", "high", "ultra")

    // ---- seed preview (Minimap.js) ----
    private val previewGrid = 160
    private var previewBmp: Bitmap? = null
    private var previewSeed = Int.MIN_VALUE
    private var previewAt = 0L

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val logical = RectF(0f, 0f, 1920f, 1080f)
    private var scale = 1f
    private var ox = 0f
    private var oy = 0f

    // ---- geometry (right-hand card, the web's fm-form) ----
    private val rCard = RectF(1170f, 84f, 1892f, 996f)
    private val rPreview = RectF(1206f, 196f, 1856f, 470f)
    private val rSeedMinus = RectF(1206f, 492f, 1266f, 540f)
    private val rSeedPlus = RectF(1796f, 492f, 1856f, 540f)
    private val rSeedDice = RectF(1282f, 492f, 1342f, 540f)
    private val rName = RectF(1372f, 556f, 1856f, 604f)
    private val rQualitySeg = List(4) { RectF(1206f + it * 166f, 626f, 1206f + it * 166f + 154f, 668f) }
    private val rNew = RectF(1206f, 694f, 1856f, 762f)
    private val rDemo = RectF(1206f, 778f, 1856f, 846f)
    private val rResume = RectF(1206f, 876f, 1856f, 962f)

    private val COL_GOLD = Color.rgb(255, 214, 107)
    private val COL_CYAN = Color.rgb(143, 224, 255)
    private val COL_SUB = Color.argb(170, 255, 255, 255)

    /** Minimap.js RAMP — the same ten-stop height colour ramp. */
    private val RAMP = arrayOf(
        floatArrayOf(-24f, 18f, 40f, 58f), floatArrayOf(-6f, 30f, 74f, 96f),
        floatArrayOf(-0.5f, 62f, 122f, 134f), floatArrayOf(0.6f, 190f, 176f, 138f),
        floatArrayOf(4f, 108f, 128f, 74f), floatArrayOf(26f, 92f, 114f, 64f),
        floatArrayOf(70f, 122f, 118f, 78f), floatArrayOf(130f, 122f, 112f, 98f),
        floatArrayOf(180f, 196f, 200f, 202f), floatArrayOf(260f, 236f, 242f, 246f),
    )

    init {
        // the menu runs before the HUD; the GL surface below keeps rendering the saved world
        postOnAnimation(object : Runnable {
            override fun run() {
                // phase 1 (New/Demo/Resume chosen): dismiss only when the world actually
                // exists — the menu itself is the "Building the world…" progress screen.
                // A failed rebuild (initError) drops back to the chooser with the error shown.
                if (phase == 1) {
                    val r = game?.renderer
                    if (r?.initError != null) phase = 0
                    else if (r?.worldReady() == true) { phase = 0; host?.onMenuResume() }
                }
                ensurePreview()
                invalidate()
                postOnAnimation(this)
            }
        })
    }

    fun hasSavedCity(): Boolean {
        val edits = prefs.getString("edits", "") ?: ""
        val mode = prefs.getInt("mode", 1)
        return mode == 1 || edits.isNotEmpty() // a demo city is a city; a new one needs edits
    }

    /** How long the boot world build has been running (the menu's loading readout). */
    private val bootAt = System.currentTimeMillis()
    private fun bootSeconds(): String = ((System.currentTimeMillis() - bootAt) / 1000L).toString()

    // ---------------------------------------------------------------- seed preview (Minimap.js)

    /** paintRelief: hillshaded survey chart from the REAL generator at 160² samples. */
    private var previewRunning = false

    private fun ensurePreview() {
        val now = System.currentTimeMillis()
        if (previewBmp != null && previewSeed == seed) return
        if (previewRunning) return
        if (previewAt != 0L && now - previewAt < 400) return // debounce like the web (140/460 ms)
        val live = game?.renderer
        // Boot discipline (the emulator gate caught this): NEVER allocate anything heavy while
        // the GL thread is building the world — the 192 MB app heap OOMs. Wait until the world
        // exists; then the matching seed samples the LIVE heightmap (no allocation) and a
        // different seed gets a temp heightmap on this user-paced thread.
        if (live == null || !live.worldReady()) return
        previewAt = now
        previewSeed = seed
        previewRunning = true
        Thread {
            try {
                val useLive = live.worldSeedMatches(seed)
                val hm = if (useLive) null else Heightmap(size = 2048, spacing = 4, seed = seed).generate()
                val g = previewGrid
                val viewHalf = 1180.0
                val step = viewHalf * 2 / (g - 1)
                val H = FloatArray(g * g)
                for (j in 0 until g) for (i in 0 until g) {
                    val x = -viewHalf + i * step
                    val z = -viewHalf + j * step
                    H[j * g + i] = (if (useLive) live.heightAt(x, z).toDouble() else hm!!.getHeight(x, z)).toFloat()
                }
                val px = IntArray(g * g)
                val c = FloatArray(3)
                val lx = -0.62f; val ly = 0.66f; val lz = -0.42f
                for (j in 0 until g) for (i in 0 until g) {
                    val k = j * g + i
                    val h = H[k]
                    ramp(h, c)
                    val hl = H[j * g + max(0, i - 1)]
                    val hr = H[j * g + min(g - 1, i + 1)]
                    val hd = H[max(0, j - 1) * g + i]
                    val hu = H[min(g - 1, j + 1) * g + i]
                    val dx = (hr - hl) / (2 * step).toFloat()
                    val dz = (hu - hd) / (2 * step).toFloat()
                    val inv = 1.0 / kotlin.math.sqrt(dx * dx + dz * dz + 1.0)
                    val shadeRaw = (-dx * inv).toFloat() * lx + (inv).toFloat() * ly + (-dz * inv).toFloat() * lz
                    var shade = 0.52f + 0.72f * max(0f, shadeRaw)
                    if (h <= 0f) shade = 0.82f + 0.18f * shade
                    px[k] = Color.rgb(
                        min(255f, c[0] * shade).roundToInt(),
                        min(255f, c[1] * shade).roundToInt(),
                        min(255f, c[2] * shade).roundToInt())
                }
                val bmp = Bitmap.createBitmap(g, g, Bitmap.Config.ARGB_8888)
                bmp.setPixels(px, 0, g, 0, 0, g, g)
                previewBmp = bmp
                postInvalidate()
            } catch (t: Throwable) {
                previewAt = 0L
            } finally {
                previewRunning = false
            }
        }.start()
    }

    private fun ramp(h: Float, out: FloatArray) {
        var i = 0
        while (i < RAMP.size - 1 && h > RAMP[i + 1][0]) i++
        val a = RAMP[max(0, i)]
        val b = RAMP[min(RAMP.size - 1, i + 1)]
        val t = if (b[0] == a[0]) 0f else ((h - a[0]) / (b[0] - a[0])).coerceIn(0f, 1f)
        out[0] = a[1] + (b[1] - a[1]) * t
        out[1] = a[2] + (b[2] - a[2]) * t
        out[2] = a[3] + (b[3] - a[3]) * t
    }

    // ---------------------------------------------------------------- drawing

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        val sx = w / logical.width()
        val sy = h / logical.height()
        scale = max(sx, sy)
        ox = (w - logical.width() * scale) / 2f
        oy = (h - logical.height() * scale) / 2f
    }

    private fun text(canvas: Canvas, value: String, x: Float, y: Float, size: Float, color: Int, bold: Boolean, align: Paint.Align = Paint.Align.LEFT) {
        paint.color = color
        paint.textSize = size
        paint.typeface = if (bold) android.graphics.Typeface.DEFAULT_BOLD else android.graphics.Typeface.DEFAULT
        paint.textAlign = align
        canvas.drawText(value, x, y, paint)
    }

    private fun glass(canvas: Canvas, rect: RectF) {
        paint.style = Paint.Style.FILL
        paint.color = Color.argb(196, 13, 21, 29)
        canvas.drawRoundRect(rect, 18f, 18f, paint)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 2f
        paint.color = Color.argb(75, 151, 210, 233)
        canvas.drawRoundRect(rect, 18f, 18f, paint)
        paint.style = Paint.Style.FILL
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.save()
        canvas.translate(ox, oy)
        canvas.scale(scale, scale)
        // while the world builds, the SurfaceView hole shows the window background — the veil
        // must be OPAQUE then (the white-screen report), translucent only over a LIVE world
        val ready = game?.renderer?.worldReady() == true
        paint.color = if (ready) Color.argb(110, 6, 10, 16) else Color.argb(255, 6, 10, 16)
        canvas.drawRect(logical, paint)

        glass(canvas, rCard)
        paint.color = COL_GOLD
        canvas.drawCircle(1246f, 148f, 20f, paint)
        text(canvas, "F", 1246f, 158f, 26f, Color.rgb(13, 21, 29), true, Paint.Align.CENTER)
        text(canvas, "FABLE CITIES", 1282f, 150f, 30f, Color.WHITE, true)
        text(canvas, "a city-builder you can grow from one street", 1282f, 176f, 13f, COL_SUB, false)

        // seed preview: hillshaded relief of the land this seed generates (Minimap.js)
        val bmp = previewBmp
        if (bmp != null) {
            paint.color = Color.argb(255, 8, 14, 20)
            canvas.drawRoundRect(rPreview, 12f, 12f, paint)
            val save = canvas.save()
            canvas.clipRect(rPreview)
            canvas.drawBitmap(bmp, null, rPreview, paint)
            // the playable-map survey frame (MAP_HALF inside VIEW_HALF)
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 2f
            paint.color = Color.argb(87, 255, 255, 255)
            val f = (1024f / 1180f)
            val mx = rPreview.centerX() - rPreview.width() / 2 * f
            val my = rPreview.centerY() - rPreview.height() / 2 * f
            canvas.drawRoundRect(RectF(mx, my, rPreview.right - (mx - rPreview.left), rPreview.bottom - (my - rPreview.top)), 4f, 4f, paint)
            paint.style = Paint.Style.FILL
            canvas.restoreToCount(save)
            text(canvas, "Seed $seed · 2048 m", 1206f, 488f, 12f, COL_SUB, false)
        } else {
            text(canvas, "surveying the land…", rPreview.centerX(), rPreview.centerY(), 14f, COL_SUB, false, Paint.Align.CENTER)
        }

        // seed row
        for (r in listOf(rSeedMinus, rSeedPlus, rSeedDice)) {
            paint.color = Color.argb(30, 255, 255, 255)
            canvas.drawRoundRect(r, 9f, 9f, paint)
        }
        text(canvas, "−", rSeedMinus.centerX(), rSeedMinus.centerY() + 7f, 20f, Color.WHITE, true, Paint.Align.CENTER)
        text(canvas, "+", rSeedPlus.centerX(), rSeedPlus.centerY() + 7f, 20f, Color.WHITE, true, Paint.Align.CENTER)
        text(canvas, "⚄", rSeedDice.centerX(), rSeedDice.centerY() + 7f, 18f, Color.WHITE, true, Paint.Align.CENTER)
        text(canvas, seed.toString(), 1520f, rSeedMinus.centerY() + 8f, 20f, COL_GOLD, true, Paint.Align.CENTER)

        // city name
        paint.color = Color.argb(30, 255, 255, 255)
        canvas.drawRoundRect(rName, 9f, 9f, paint)
        text(canvas, if (cityName.isEmpty()) "New Fable" else cityName, rName.centerX(), rName.centerY() + 6f, 16f,
            if (cityName.isEmpty()) COL_SUB else Color.WHITE, false, Paint.Align.CENTER)

        // quality seg
        for ((i, q) in qualities.withIndex()) {
            val r = rQualitySeg[i]
            val on = q == quality
            paint.color = if (on) Color.argb(90, 151, 210, 233) else Color.argb(30, 255, 255, 255)
            canvas.drawRoundRect(r, 9f, 9f, paint)
            if (on) { paint.style = Paint.Style.STROKE; paint.strokeWidth = 2f; paint.color = COL_CYAN
                canvas.drawRoundRect(r, 9f, 9f, paint); paint.style = Paint.Style.FILL }
            text(canvas, q.uppercase(), r.centerX(), r.centerY() + 4f, 11f, Color.WHITE, on, Paint.Align.CENTER)
        }

        // actions
        paint.color = Color.rgb(31, 122, 89)
        canvas.drawRoundRect(rNew, 12f, 12f, paint)
        text(canvas, "NEW CITY", rNew.centerX(), rNew.centerY() + 7f, 19f, Color.WHITE, true, Paint.Align.CENTER)
        paint.color = Color.argb(60, 31, 96, 122)
        canvas.drawRoundRect(rDemo, 12f, 12f, paint)
        text(canvas, "DEMO CITY", rDemo.centerX(), rDemo.centerY() + 7f, 17f, Color.WHITE, true, Paint.Align.CENTER)
        if (phase == 1 || !ready) {
            // Long/500 overflows Int (3.5e9 > Int.MAX) — toInt() goes NEGATIVE and repeat(-1)
            // crashes the first onDraw (the emulator gate caught this). Modulo the Long first.
            val dot = "...".repeat(1 + ((System.currentTimeMillis() / 500L % 3L).toInt()))
            val err = game?.renderer?.initError
            if (err != null) {
                text(canvas, "GPU init failed: $err", rCard.centerX(), rCard.bottom - 40f, 13f, Color.rgb(255, 128, 128), true, Paint.Align.CENTER)
            } else {
                val since = if (phase == 1) buildingAt else bootAt
                val secs = (System.currentTimeMillis() - since) / 1000L
                text(canvas, "Building the world$dot · ${secs}s", rCard.centerX(), rCard.bottom - 22f, 12f, COL_CYAN, false, Paint.Align.CENTER)
                text(canvas, "first boot compiles shaders — up to a minute on some phones", rCard.centerX(), rCard.bottom - 42f, 10f, COL_SUB, false, Paint.Align.CENTER)
            }
        }

        // resume card (menu/index.js loadName/loadMeta)
        if (hasSavedCity()) {
            glass(canvas, rResume)
            text(canvas, "RESUME", 1230f, rResume.top + 38f, 15f, COL_CYAN, true)
            val name = prefs.getString("cityName", "New Fable") ?: "New Fable"
            val pop = prefs.getInt("population", 0)
            val money = prefs.getInt("money", 350_000)
            text(canvas, name, 1230f, rResume.top + 66f, 15f, Color.WHITE, true)
            text(canvas, "${String.format("%,d", pop)} citizens · ${fmtMoney(money.toDouble())}", 1230f, rResume.top + 86f, 12f, COL_SUB, false)
        }

        // GPU/render-path diagnostics (white-screen defence): the renderer reports its own
        // state every few seconds — on a misbehaving driver the screen shows WHY it looks
        // the way it does instead of a dead surface.
        val diag = game?.renderer?.diagLine
        if (!diag.isNullOrEmpty()) text(canvas, diag, 16f, 1070f, 10f, Color.argb(150, 190, 214, 230), false)
        canvas.restore()
    }

    

    // ---------------------------------------------------------------- touch

    private fun toLogical(x: Float, y: Float): FloatArray = floatArrayOf((x - ox) / scale, (y - oy) / scale)

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked != MotionEvent.ACTION_DOWN) return phase == 1
        val p = toLogical(event.x, event.y)
        val x = p[0]; val y = p[1]
        if (phase == 1) return true
        when {
            rSeedMinus.contains(x, y) -> { seed = (seed - 1).coerceAtLeast(0); previewSeed = Int.MIN_VALUE; persist() }
            rSeedPlus.contains(x, y) -> { seed = (seed + 1).coerceAtMost(999_999_999); previewSeed = Int.MIN_VALUE; persist() }
            rSeedDice.contains(x, y) -> { seed = (0..999_999_999).random(); previewSeed = Int.MIN_VALUE; persist() }
            rName.contains(x, y) -> nameDialog()
            rNew.contains(x, y) -> start(GlCityRenderer.MODE_NEW)
            rDemo.contains(x, y) -> start(GlCityRenderer.MODE_DEMO)
            rResume.contains(x, y) -> {
                if (hasSavedCity()) {
                    persist()
                    // resume waits out the boot build too — dismissing mid-build shows a HUD
                    // over a half-built world; the phase-1 loop dismisses when it is ready
                    if (game?.renderer?.worldReady() == true) host?.onMenuResume()
                    else { buildingAt = System.currentTimeMillis(); phase = 1 }
                }
            }
            else -> {
                for ((i, q) in qualities.withIndex()) if (rQualitySeg[i].contains(x, y)) {
                    quality = q
                    prefs.edit().putString("qualityName", q).apply()
                    val r: GlCityRenderer? = game?.renderer
                    if (r != null) {
                        r.setQuality(q)
                        r.qualityAuto = false // a hand-picked preset stops the auto guard (perfguard)
                    }
                }
            }
        }
        invalidate()
        return true
    }

    private fun start(mode: Int) {
        phase = 1
        persist()
        buildingAt = System.currentTimeMillis()
        host?.onMenuStart(seed, mode, if (cityName.isBlank()) "New Fable" else cityName)
    }

    private fun persist() {
        prefs.edit().putInt("menuSeed", seed).apply()
    }

    private fun nameDialog() {
        val input = android.widget.EditText(context)
        input.setText(cityName)
        input.setSelection(input.text.length)
        android.app.AlertDialog.Builder(context)
            .setTitle("Name your city")
            .setView(input)
            .setPositiveButton("Done") { d, _ ->
                cityName = input.text.toString().trim().take(32)
                d.dismiss()
                invalidate()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }
}
