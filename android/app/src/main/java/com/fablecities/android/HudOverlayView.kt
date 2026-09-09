package com.fablecities.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View
import com.fablecities.android.worldgen.SERVICE_TYPES

/**
 * Canvas port of the site's HUD (src/modules/ui): topbar (brand + city name + milestone badge +
 * progress, date / 24 h day dial / clock / speed group, treasury + net, population + jobs,
 * happiness + meter, notifications bell, settings), the bottom dock with the catalog categories
 * (Roads / Zoning / Services / Bulldoze / Info Views) and their item tray with costs, the RCI+O
 * demand bars, the active-tool pill, toast stack, notifications centre, settings sheet and the
 * building info panel. All essential actions are large touch targets inside the letterboxed
 * 1920x1080 logical surface; playfield touches fall through to the GL view.
 */
class HudOverlayView(context: Context) : View(context) {

    // ---------------------------------------------------------------- state

    var gameView: FableCitiesView? = null
    private val savedState = CityState.load(context)

    /** Tool token: "SELECT" | "BULLDOZE" | "ROAD:<id>" | "ZONE:<id>" | "SERVICE:<id>" | "INFO:<id>". */
    var toolToken: String = CityState.normalizeTool(savedState.selectedTool)
        private set

    private var openCat: Cat? = null
    private val lastItem = HashMap<String, String>() // catId -> armed item id
    private var message = "Welcome to Fable Cities"
    private var messageTime = 5f
    private var hudHidden = context.getSharedPreferences("fable_cities_city", Context.MODE_PRIVATE)
        .getBoolean("hudHidden", false)
    private var draggingSlider = false

    // notifications centre (toasts.js port)
    private data class Notif(val text: String, val day: Int, val kind: String)
    private val notifs = ArrayList<Notif>()
    private var unread = 0
    private var showNotifications = false
    private var showSettings = false
    private var lastFeedPoll = 0L

    // toasts (text, enqueued-at-ms, colour)
    private val toasts = ArrayList<Pair<String, Int>>() // text to colour

    private var infoLines: List<String>? = null

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val logical = RectF(0f, 0f, 1920f, 1080f)
    private val viewport = RectF()
    private var scale = 1f
    private var lastFrameNanos = 0L
    private var running = true

    private val frameCallback = object : Runnable {
        override fun run() {
            val now = System.nanoTime()
            val dt = if (lastFrameNanos == 0L) 0.016f else ((now - lastFrameNanos) / 1_000_000_000f).coerceIn(0f, 0.1f)
            lastFrameNanos = now
            if (running) {
                if (messageTime > 0f) messageTime = (messageTime - dt).coerceAtLeast(0f)
                pollFeed(now)
                infoLines = if (toolToken == "SELECT" && !hudHidden) gameView?.renderer?.buildingInfo()?.split('\n') else null
                invalidate()
                postOnAnimation(this)
            }
        }
    }

    private fun pollFeed(now: Long) {
        val gv = gameView ?: return
        if (now - lastFeedPoll < 2_000_000_000L) return
        lastFeedPoll = now
        for (n in gv.renderer.drainUiFeed()) {
            notifs.add(Notif(n.second, gv.renderer.day, n.first))
            if (notifs.size > 40) notifs.removeAt(0)
            unread++
            toast(n.second, if (n.first == "alert") COL_UPKEEP else COL_GOLD)
        }
    }

    init {
        postOnAnimation(frameCallback)
    }

    // ---------------------------------------------------------------- catalog

    private enum class Cat(val id: String, val label: String, val color: Int, val key: String, val direct: Boolean) {
        ROADS("roads", "Roads", Color.rgb(159, 196, 232), "1", false),
        ZONING("zoning", "Zoning", Color.rgb(143, 217, 90), "2", false),
        SERVICES("services", "Services", Color.rgb(79, 195, 247), "3", false),
        BULLDOZE("bulldoze", "Bulldoze", Color.rgb(255, 107, 107), "4", true),
        INFO("info", "Info Views", Color.rgb(181, 124, 240), "5", false),
    }

    private data class Item(val id: String, val tool: String, val chip: String, val label: String,
                            val cost: String, val color: Int)

    private fun items(cat: Cat): List<Item> = when (cat) {
        Cat.ROADS -> ROAD_SPECS.map {
            Item(it.id, "ROAD", it.short, it.label, "${fmtMoney(it.cost.toDouble())} / m", colOf(it.color))
        }
        Cat.ZONING -> ZONE_SPECS.map {
            Item(it.id, "ZONE", chipShort(it.id), it.label, "Free", colOf(it.color))
        }
        Cat.SERVICES -> SERVICE_TYPES.entries.map { (id, s) ->
            Item(id, "SERVICE", shortService(s.name), s.name, fmtMoney(s.cost.toDouble()), colService(id))
        }
        Cat.BULLDOZE -> emptyList()
        Cat.INFO -> INFO_VIEW_IDS.map {
            Item(it, "INFO", INFO_VIEW_LABELS[it] ?: it, INFO_VIEW_LABELS[it] ?: it, "Free",
                colOf(INFO_VIEW_COLORS[it] ?: floatArrayOf(1f, 1f, 1f)))
        }
    }

    private fun chipShort(id: String) = when (id) {
        "res-low" -> "Res · Low"; "res-high" -> "Res · High"; "com-low" -> "Com · Low"
        "com-high" -> "Com · High"; "ind" -> "Industrial"; else -> "Office"
    }

    private fun shortService(n: String) = n.replace(" Plant", "").replace(" Treatment", " Treat.")

    private fun colOf(c: FloatArray): Int = Color.rgb((c[0] * 255).toInt(), (c[1] * 255).toInt(), (c[2] * 255).toInt())
    private fun colService(id: String): Int = when (id) {
        "power" -> Color.rgb(244, 185, 66); "water" -> Color.rgb(79, 195, 247)
        "sewage" -> Color.rgb(201, 162, 126); "garbage" -> Color.rgb(156, 204, 101)
        "police" -> Color.rgb(140, 156, 240); "fire" -> Color.rgb(255, 123, 107)
        "health" -> Color.rgb(255, 159, 182); else -> Color.rgb(255, 167, 38)
    }

    private fun itemOf(cat: Cat, id: String?): Item? = items(cat).firstOrNull { it.id == id }

    private fun armedTool(cat: Cat, item: Item): String = "${item.tool}:${item.id}"

    private fun catOfToken(token: String): Cat? = when (token.substringBefore(':')) {
        "ROAD" -> Cat.ROADS; "ZONE" -> Cat.ZONING; "SERVICE" -> Cat.SERVICES
        "BULLDOZE" -> Cat.BULLDOZE; "INFO" -> Cat.INFO; else -> null
    }

    // ---------------------------------------------------------------- geometry

    private val rTopLeft = RectF(28f, 20f, 560f, 96f)
    private val rTopCentre = RectF(600f, 20f, 1180f, 96f)
    private val rTopRight = RectF(1220f, 20f, 1892f, 96f)
    private val rDial = RectF(726f, 34f, 774f, 82f)
    private val rSpeed = arrayOf(
        RectF(962f, 36f, 1010f, 80f), RectF(1016f, 36f, 1064f, 80f),
        RectF(1070f, 36f, 1118f, 80f), RectF(1124f, 36f, 1172f, 80f))
    private val rBell = RectF(1706f, 32f, 1754f, 84f)
    private val rGear = RectF(1766f, 32f, 1814f, 84f)
    private val rDemand = RectF(28f, 120f, 268f, 302f)
    private val rDemandBars = arrayOf(
        RectF(48f, 156f, 92f, 276f), RectF(100f, 156f, 144f, 276f),
        RectF(152f, 156f, 196f, 276f), RectF(204f, 156f, 248f, 276f))
    private val rWebChip = RectF(28f, 312f, 240f, 360f)
    private val rDock = RectF(340f, 900f, 1560f, 1046f)
    private val rDockBtns = List(5) { RectF(360f + it * 240f, 918f, 580f + it * 240f, 1028f) }
    private val rTray = RectF(340f, 640f, 1560f, 886f)
    private val rPill = RectF(1580f, 900f, 1892f, 984f)
    private val rHints = RectF(1580f, 996f, 1892f, 1046f)
    private val rMessage = RectF(28f, 902f, 330f, 1010f)
    private val rSheetNotif = RectF(1280f, 120f, 1892f, 820f)
    private val rSheetSettings = RectF(1280f, 120f, 1892f, 860f)
    private val rGhost = RectF(28f, 28f, 150f, 74f)

    private fun trayItemRect(i: Int): RectF =
        RectF(354f + (i % 4) * 300f, 706f + (i / 4) * 90f, 354f + (i % 4) * 300f + 285f, 706f + (i / 4) * 90f + 80f)

    private fun sheetCloseRect(sheet: RectF): RectF = RectF(sheet.right - 56f, sheet.top + 8f, sheet.right - 16f, sheet.top + 48f)

    // weather chips inside the settings sheet
    private fun weatherRect(i: Int): RectF = RectF(1304f + i * 108f, 214f, 1304f + i * 108f + 100f, 258f)
    private val rSlider = RectF(1304f, 316f, 1868f, 352f)
    private val rToggleHide = RectF(1800f, 414f, 1868f, 454f)
    private val rRowRename = RectF(1296f, 470f, 1876f, 520f)
    private val rRowWeb = RectF(1296f, 530f, 1876f, 580f)

    private fun infoPanelRect(lines: Int): RectF = RectF(28f, 120f, 420f, 132f + (lines + 1) * 24f + 14f)

    // ---------------------------------------------------------------- colours

    private val COL_GOLD = Color.rgb(255, 214, 107)
    private val COL_CYAN = Color.rgb(143, 224, 255)
    private val COL_GREEN = Color.rgb(111, 224, 140)
    private val COL_AMBER = Color.rgb(255, 194, 71)
    private val COL_RED = Color.rgb(255, 107, 107)
    private val COL_SUB = Color.rgb(184, 202, 211)
    private val COL_UPKEEP = Color.rgb(255, 139, 122)

    // ---------------------------------------------------------------- lifecycle

    fun showMessage(text: String) {
        message = text
        messageTime = 3.5f
        post { invalidate() }
    }

    private fun toast(text: String, color: Int) {
        toasts.add(text to color)
        if (toasts.size > 3) toasts.removeAt(0)
        postDelayed({ if (toasts.isNotEmpty()) { toasts.removeAt(0); invalidate() } }, 3400)
    }

    private fun money(): Int = gameView?.renderer?.econMoney() ?: 0
    private fun population(): Int = gameView?.renderer?.econPopulation() ?: 0
    private fun jobs(): Int = gameView?.renderer?.econJobs() ?: 0

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        val vw = minOf(w.toFloat(), h * 16f / 9f)
        val vh = vw * 9f / 16f
        viewport.set((w - vw) / 2f, (h - vh) / 2f, (w + vw) / 2f, (h + vh) / 2f)
        scale = vw / logical.width()
    }

    private fun toLogical(x: Float, y: Float): FloatArray =
        floatArrayOf((x - viewport.left) / scale, (y - viewport.top) / scale)

    // ---------------------------------------------------------------- touch

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                val p = toLogical(event.x, event.y)
                return onDown(p[0], p[1])
            }
            MotionEvent.ACTION_MOVE -> {
                if (draggingSlider) {
                    val p = toLogical(event.x, event.y)
                    val frac = ((p[0] - rSlider.left) / rSlider.width()).coerceIn(0f, 1f)
                    gameView?.renderer?.setHour(frac * 24f)
                    invalidate()
                    return true
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> draggingSlider = false
        }
        return false // playfield: fall through to the GL view
    }

    private fun onDown(x: Float, y: Float): Boolean {
        val gv = gameView ?: return false
        if (hudHidden) {
            if (rGhost.contains(x, y)) {
                hudHidden = false
                prefs().edit().putBoolean("hudHidden", false).apply()
                invalidate()
                return true
            }
            return false
        }
        // sheets swallow everything while open
        if (showNotifications) {
            if (sheetCloseRect(rSheetNotif).contains(x, y)) { showNotifications = false; unread = 0; invalidate(); return true }
            if (!rSheetNotif.contains(x, y)) { showNotifications = false; unread = 0; invalidate() }
            return true
        }
        if (showSettings) {
            if (sheetCloseRect(rSheetSettings).contains(x, y)) { showSettings = false; invalidate(); return true }
            if (!rSheetSettings.contains(x, y)) { showSettings = false; invalidate(); return true }
            for (i in WEATHER_PRESETS.indices) if (weatherRect(i).contains(x, y)) {
                gv.renderer.setWeather(WEATHER_PRESETS[i])
                toast("Weather: ${WEATHER_PRESETS[i]}", COL_CYAN)
                invalidate(); return true
            }
            if (rSlider.contains(x, y)) {
                draggingSlider = true
                val frac = ((x - rSlider.left) / rSlider.width()).coerceIn(0f, 1f)
                gv.renderer.setHour(frac * 24f)
                invalidate(); return true
            }
            if (rToggleHide.contains(x, y)) {
                hudHidden = true
                prefs().edit().putBoolean("hudHidden", true).apply()
                invalidate(); return true
            }
            if (rRowRename.contains(x, y)) { showSettings = false; renameDialog(); invalidate(); return true }
            if (rRowWeb.contains(x, y)) {
                context.startActivity(android.content.Intent(context, ParityActivity::class.java))
                invalidate(); return true
            }
            return true
        }

        // topbar
        if (rTopLeft.contains(x, y)) { renameDialog(); return true }
        for (i in rSpeed.indices) if (rSpeed[i].contains(x, y)) {
            if (i == 0) gv.renderer.paused = true
            else { gv.renderer.paused = false; gv.renderer.simSpeed = intArrayOf(1, 1, 2, 4)[i] }
            showMessage(if (i == 0) "Simulation paused" else "Speed ${intArrayOf(1, 1, 2, 4)[i]}×")
            invalidate(); return true
        }
        if (rBell.contains(x, y)) { showNotifications = true; unread = 0; invalidate(); return true }
        if (rGear.contains(x, y)) { showSettings = true; invalidate(); return true }
        if (rWebChip.contains(x, y)) {
            context.startActivity(android.content.Intent(context, ParityActivity::class.java))
            showMessage("Opening the 1:1 web-parity build…")
            invalidate(); return true
        }

        // info panel close
        infoLines?.let { lines ->
            val r = infoPanelRect(lines.size)
            if (r.contains(x, y) && x > r.right - 44f && y < r.top + 44f) {
                gv.renderer.clearSelection()
                infoLines = null
                invalidate(); return true
            }
        }

        // dock (before the tray: the toggle semantics of a category button win)
        for ((i, cat) in Cat.entries.withIndex()) {
            if (rDockBtns[i].contains(x, y)) {
                if (cat.direct) {
                    toolToken = if (toolToken == "BULLDOZE") "SELECT" else "BULLDOZE"
                    showMessage(if (toolToken == "BULLDOZE") "Bulldoze ready — 50 % refund" else "Tool cancelled")
                } else if (openCat === cat) {
                    openCat = null
                    toolToken = "SELECT"
                    showMessage("Tool cancelled")
                } else {
                    openCat = cat
                    val armId = lastItem[cat.id] ?: items(cat).firstOrNull()?.id
                    val item = itemOf(cat, armId)
                    if (item != null) toolToken = armedTool(cat, item)
                    showMessage("${cat.label}: pick an option")
                }
                invalidate(); return true
            }
        }

        // tray items
        openCat?.let { cat ->
            val its = items(cat)
            for ((i, item) in its.withIndex()) {
                if (trayItemRect(i).contains(x, y)) {
                    toolToken = armedTool(cat, item)
                    lastItem[cat.id] = item.id
                    openCat = null // phone behaviour: the chooser gets out of the way, tool stays armed
                    showMessage("${item.label} — ${item.desc()}")
                    invalidate(); return true
                }
            }
            if (rTray.contains(x, y)) return true // swallowed by the tray body
            openCat = null // tap outside closes the chooser
            invalidate()
        }

        // tool pill -> back to select
        if (rPill.contains(x, y) && toolToken != "SELECT") {
            toolToken = "SELECT"
            showMessage("Tool cancelled")
            invalidate(); return true
        }
        return false
    }

    private fun Item.desc(): String = when (tool) {
        "ROAD" -> ROAD_SPECS.firstOrNull { it.id == id }?.let { "${it.label} • ${fmtMoney(it.cost * 24.0)} per cell" } ?: ""
        "ZONE" -> ZONE_SPECS.firstOrNull { it.id == id }?.let { "${it.label} zone" } ?: ""
        "SERVICE" -> SERVICE_TYPES[id]?.let { "${it.name} • radius ${it.radius.toInt()} m" } ?: ""
        else -> "Info overlay"
    }

    private fun prefs() = context.getSharedPreferences("fable_cities_city", Context.MODE_PRIVATE)

    private fun renameDialog() {
        val gv = gameView ?: return
        val input = android.widget.EditText(context)
        input.setText(gv.renderer.cityName())
        input.setSelection(input.text.length)
        android.app.AlertDialog.Builder(context)
            .setTitle("City name")
            .setMessage("Click to rename your city.")
            .setView(input, 40, 16, 40, 8)
            .setPositiveButton("Rename") { _, _ ->
                val v = input.text.toString().trim().take(32)
                if (v.isNotEmpty()) {
                    gv.renderer.setCityName(v)
                    showMessage("Renamed to $v")
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // ---------------------------------------------------------------- draw

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.save()
        canvas.clipRect(viewport)
        canvas.translate(viewport.left, viewport.top)
        canvas.scale(scale, scale)
        if (hudHidden) {
            paint.style = Paint.Style.FILL
            paint.color = Color.argb(120, 13, 21, 29)
            canvas.drawRoundRect(rGhost, 12f, 12f, paint)
            text(canvas, "SHOW HUD", 52f, 58f, 14f, Color.WHITE, true, Paint.Align.CENTER)
            canvas.restore()
            return
        }
        drawTopbar(canvas)
        drawDemand(canvas)
        drawWebChip(canvas)
        drawTray(canvas)
        drawDock(canvas)
        drawPillAndHints(canvas)
        drawToasts(canvas)
        drawMessage(canvas)
        drawInfoPanel(canvas)
        if (showNotifications) drawNotifSheet(canvas)
        if (showSettings) drawSettingsSheet(canvas)
        canvas.restore()
    }

    private fun drawTopbar(canvas: Canvas) {
        val gv = gameView
        val hour = gv?.renderer?.hour ?: 14f
        val day = gv?.renderer?.day ?: 1
        val paused = gv?.isPaused() ?: false

        // ---- left: brand + city name + milestone
        glass(canvas, rTopLeft)
        paint.color = COL_GOLD
        canvas.drawCircle(56f, 46f, 15f, paint)
        paint.color = Color.rgb(13, 21, 29)
        text(canvas, "F", 56f, 54f, 20f, Color.rgb(13, 21, 29), true, Paint.Align.CENTER)
        text(canvas, gv?.renderer?.cityName() ?: "New Fable", 86f, 52f, 22f, Color.WHITE, true)
        text(canvas, "TAP TO RENAME", 86f, 76f, 9f, COL_SUB, false)
        val msName = gv?.renderer?.econMilestone() ?: "Founding"
        text(canvas, "★ $msName", 300f, 52f, 13f, COL_GOLD, true)
        val prog = (gv?.renderer?.econMilestoneProgress() ?: 1.0).coerceIn(0.0, 1.0).toFloat()
        val next = gv?.renderer?.econMilestoneNext()
        val sub = if (next != null) "next: $next" else "highest reached"
        text(canvas, sub, 300f, 76f, 10f, COL_SUB, false)
        val bar = RectF(300f, 82f, 540f, 88f)
        paint.color = Color.argb(60, 255, 255, 255); canvas.drawRoundRect(bar, 3f, 3f, paint)
        paint.color = COL_GOLD
        if (prog > 0f) canvas.drawRoundRect(RectF(bar.left, bar.top, bar.left + (bar.width()) * prog, bar.bottom), 3f, 3f, paint)

        // ---- centre: date / dial / clock / speed
        glass(canvas, rTopCentre)
        val date = WORLD_EPOCH.plusDays((day - 1).toLong())
        val month = listOf("January", "February", "March", "April", "May", "June", "July", "August",
            "September", "October", "November", "December")[date.monthValue - 1]
        val weekday = listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")[date.dayOfWeek.value - 1]
        text(canvas, "${date.dayOfMonth} ${month.take(3)} ${date.year}", 620f, 52f, 16f, Color.WHITE, true)
        text(canvas, weekday, 620f, 76f, 11f, COL_SUB, false)
        divider(canvas, 716f)

        drawDial(canvas, hour)
        val h = hour.toInt().coerceIn(0, 23)
        val m = ((hour - hour.toInt()) * 60f).toInt()
        text(canvas, String.format("%02d:%02d", h, m), 796f, 52f, 21f, Color.WHITE, true)
        text(canvas, if (paused) "Paused" else dayPhase(hour), 796f, 76f, 11f,
            if (paused) COL_AMBER else COL_SUB, false)
        divider(canvas, 946f)

        val effSpeed = if (paused) 0 else gv?.renderer?.simSpeed ?: 1
        val labels = arrayOf("II", "1×", "2×", "4×")
        for (i in rSpeed.indices) {
            val on = if (effSpeed == 0) i == 0 else intArrayOf(1, 2, 4).indexOf(effSpeed) + 1 == i
            paint.color = if (on) Color.argb(90, 151, 210, 233) else Color.argb(30, 255, 255, 255)
            canvas.drawRoundRect(rSpeed[i], 10f, 10f, paint)
            text(canvas, labels[i], rSpeed[i].centerX(), rSpeed[i].centerY() + 6f, 15f,
                if (on) Color.WHITE else COL_SUB, on, Paint.Align.CENTER)
        }

        // ---- right: stats
        glass(canvas, rTopRight)
        val net = (gv?.renderer?.econIncome() ?: 0) - (gv?.renderer?.econExpenses() ?: 0)
        text(canvas, fmtMoney(money().toDouble()), 1250f, 52f, 19f, COL_GOLD, true)
        text(canvas, "${fmtMoney(net.toDouble(), sign = true)} / week", 1250f, 76f, 11f,
            if (net > 0) COL_GREEN else if (net < 0) COL_UPKEEP else COL_SUB, false)
        divider(canvas, 1414f)
        text(canvas, String.format("%,d", population()), 1430f, 52f, 19f, COL_CYAN, true)
        text(canvas, "${String.format("%,d", jobs())} jobs", 1430f, 76f, 11f, COL_SUB, false)
        divider(canvas, 1564f)
        val hp = (gv?.renderer?.econHappiness() ?: 0.0).coerceIn(0.0, 1.0).toFloat()
        text(canvas, "${(hp * 100).toInt()} %", 1580f, 52f, 19f,
            if (hp >= 0.65f) COL_GREEN else if (hp >= 0.4f) COL_AMBER else COL_RED, true)
        val meter = RectF(1580f, 66f, 1666f, 74f)
        paint.color = Color.argb(60, 255, 255, 255); canvas.drawRoundRect(meter, 4f, 4f, paint)
        paint.color = if (hp >= 0.65f) COL_GREEN else if (hp >= 0.4f) COL_AMBER else COL_RED
        if (hp > 0f) canvas.drawRoundRect(RectF(meter.left, meter.top, meter.left + meter.width() * hp, meter.bottom), 4f, 4f, paint)
        divider(canvas, 1694f)

        // bell with unread badge
        paint.color = Color.argb(30, 255, 255, 255)
        canvas.drawRoundRect(rBell, 10f, 10f, paint)
        drawBell(canvas, rBell.centerX(), rBell.centerY() + 2f)
        if (unread > 0) {
            paint.color = COL_RED
            canvas.drawCircle(rBell.right - 6f, rBell.top + 6f, 9f, paint)
            text(canvas, if (unread > 9) "9+" else unread.toString(), rBell.right - 6f, rBell.top + 10f, 10f, Color.WHITE, true, Paint.Align.CENTER)
        }
        // gear
        paint.color = Color.argb(30, 255, 255, 255)
        canvas.drawRoundRect(rGear, 10f, 10f, paint)
        drawGear(canvas, rGear.centerX(), rGear.centerY())
    }

    private fun drawDial(canvas: Canvas, hour: Float) {
        val cx = rDial.centerX(); val cy = rDial.centerY(); val r = rDial.width() / 2f
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 5f
        paint.color = Color.rgb(38, 52, 70) // night ring
        canvas.drawCircle(cx, cy, r - 3f, paint)
        paint.color = Color.rgb(150, 205, 235) // day arc (top half)
        canvas.drawArc(cx - r + 3f, cy - r + 3f, cx + r - 3f, cy + r - 3f, 180f, 180f, false, paint)
        paint.style = Paint.Style.FILL
        // sun/moon marker rides the ring: 12:00 at the top, clockwise
        val ang = Math.toRadians((90.0 - (hour % 24f) / 24.0 * 360.0))
        val mx = cx + (r - 3f) * Math.cos(ang).toFloat()
        val my = cy - (r - 3f) * Math.sin(ang).toFloat()
        val isDay = hour in 6f..19.5f
        paint.color = if (isDay) COL_GOLD else Color.rgb(214, 226, 240)
        canvas.drawCircle(mx, my, if (isDay) 5.5f else 4.5f, paint)
        if (isDay) {
            paint.color = Color.argb(70, 255, 230, 150)
            canvas.drawCircle(mx, my, 9f, paint)
        }
    }

    private fun drawBell(canvas: Canvas, cx: Float, cy: Float) {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 2.4f
        paint.color = Color.WHITE
        val p = android.graphics.Path()
        p.moveTo(cx - 7f, cy + 4f)
        p.lineTo(cx - 7f, cy - 1f)
        p.quadTo(cx - 7f, cy - 9f, cx, cy - 9f)
        p.quadTo(cx + 7f, cy - 9f, cx + 7f, cy - 1f)
        p.lineTo(cx + 7f, cy + 4f)
        p.close()
        canvas.drawPath(p, paint)
        canvas.drawLine(cx - 10f, cy + 4f, cx + 10f, cy + 4f, paint)
        canvas.drawCircle(cx, cy + 7.5f, 1.8f, paint)
        paint.style = Paint.Style.FILL
    }

    private fun drawGear(canvas: Canvas, cx: Float, cy: Float) {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 2.4f
        paint.color = Color.WHITE
        canvas.drawCircle(cx, cy, 6.5f, paint)
        canvas.drawCircle(cx, cy, 2.4f, paint)
        for (i in 0 until 8) {
            val a = Math.toRadians(i * 45.0)
            val x0 = cx + 6.5f * Math.cos(a).toFloat()
            val y0 = cy + 6.5f * Math.sin(a).toFloat()
            val x1 = cx + 10f * Math.cos(a).toFloat()
            val y1 = cy + 10f * Math.sin(a).toFloat()
            canvas.drawLine(x0, y0, x1, y1, paint)
        }
        paint.style = Paint.Style.FILL
    }

    private fun divider(canvas: Canvas, x: Float) {
        paint.color = Color.argb(50, 255, 255, 255)
        canvas.drawLine(x, 34f, x, 82f, paint)
    }

    private fun drawDemand(canvas: Canvas) {
        val gv = gameView ?: return
        glass(canvas, rDemand)
        text(canvas, "DEMAND", 48f, 144f, 11f, COL_SUB, true)
        val vals = floatArrayOf(
            gv.renderer.econDemandResidential().toFloat(),
            gv.renderer.econDemandCommercial().toFloat(),
            gv.renderer.econDemandIndustrial().toFloat(),
            gv.renderer.econDemandOffice().toFloat())
        val cols = intArrayOf(Color.rgb(143, 217, 90), Color.rgb(98, 198, 255), Color.rgb(241, 182, 52), Color.rgb(181, 124, 240))
        val letters = arrayOf("R", "C", "I", "O")
        for (i in rDemandBars.indices) {
            val b = rDemandBars[i]
            paint.color = Color.argb(45, 255, 255, 255)
            canvas.drawRoundRect(b, 5f, 5f, paint)
            val v = vals[i].coerceIn(0f, 1f)
            if (v > 0f) {
                val fh = 4f + v * (b.height() - 8f)
                paint.color = cols[i]
                canvas.drawRoundRect(RectF(b.left + 3f, b.bottom - 3f - fh, b.right - 3f, b.bottom - 3f), 4f, 4f, paint)
            }
            text(canvas, letters[i], b.centerX(), b.bottom + 18f, 13f, COL_SUB, true, Paint.Align.CENTER)
        }
    }

    private fun drawWebChip(canvas: Canvas) {
        glass(canvas, rWebChip)
        text(canvas, "WEB-PARITY", 44f, 336f, 13f, Color.WHITE, true)
        text(canvas, "open the 1:1 web build", 44f, 352f, 9f, COL_SUB, false)
    }

    private fun drawTray(canvas: Canvas) {
        val cat = openCat ?: return
        glass(canvas, rTray)
        paint.color = cat.color
        canvas.drawRoundRect(RectF(rTray.left + 10f, rTray.top + 12f, rTray.left + 54f, rTray.top + 56f), 8f, 8f, paint)
        text(canvas, cat.label, 442f, 666f, 16f, Color.WHITE, true)
        text(canvas, catDesc(cat.id), 442f, 686f, 11f, COL_SUB, false)
        text(canvas, "TAP AGAIN TO CLOSE", rTray.right - 20f, 666f, 10f, COL_SUB, false, Paint.Align.RIGHT)
        val its = items(cat)
        for ((i, item) in its.withIndex()) {
            val r = trayItemRect(i)
            paint.color = Color.argb(36, 255, 255, 255)
            canvas.drawRoundRect(r, 10f, 10f, paint)
            val isActive = toolToken == armedTool(cat, item)
            if (isActive) {
                paint.style = Paint.Style.STROKE; paint.strokeWidth = 2.5f; paint.color = item.color
                canvas.drawRoundRect(r, 10f, 10f, paint)
                paint.style = Paint.Style.FILL
            }
            paint.color = item.color
            canvas.drawRoundRect(RectF(r.left + 6f, r.top + 8f, r.left + 12f, r.bottom - 8f), 3f, 3f, paint)
            text(canvas, item.chip, r.left + 22f, r.top + 34f, 15f, Color.WHITE, true)
            text(canvas, item.cost, r.left + 22f, r.top + 60f, 12f, COL_GOLD, false)
        }
    }

    private fun catDesc(id: String) = when (id) {
        "roads" -> "Two-lane roads, avenues, highways and paths."
        "zoning" -> "Paint zones next to roads. Buildings grow where there is demand."
        "services" -> "Power, water, safety, health and education buildings."
        "bulldoze" -> "Demolish roads, buildings and zoning. Refunds 50 % of build cost."
        else -> "Overlay city data: traffic, land value, pollution, happiness…"
    }

    private fun drawDock(canvas: Canvas) {
        glass(canvas, rDock)
        for ((i, cat) in Cat.entries.withIndex()) {
            val r = rDockBtns[i]
            val active = (openCat === cat) || (catOfToken(toolToken) === cat)
            paint.color = if (active) Color.argb(80, 255, 255, 255) else Color.argb(30, 255, 255, 255)
            canvas.drawRoundRect(r, 14f, 14f, paint)
            paint.color = cat.color
            canvas.drawRoundRect(RectF(r.left, r.top, r.left + 6f, r.bottom), 3f, 3f, paint)
            text(canvas, cat.label, r.left + 22f, r.centerY() + 2f, 17f, Color.WHITE, true)
            text(canvas, cat.key, r.right - 18f, r.centerY() + 2f, 13f, COL_SUB, true, Paint.Align.CENTER)
            if (active) {
                paint.style = Paint.Style.STROKE; paint.strokeWidth = 2f; paint.color = cat.color
                canvas.drawRoundRect(r, 14f, 14f, paint)
                paint.style = Paint.Style.FILL
            }
        }
    }

    private fun drawPillAndHints(canvas: Canvas) {
        if (toolToken != "SELECT") {
            glass(canvas, rPill)
            val cat = catOfToken(toolToken)
            val id = toolToken.substringAfter(':')
            val color = when (cat) {
                Cat.ROADS -> colOf(ROAD_SPECS.firstOrNull { it.id == id }?.color ?: floatArrayOf(1f, 1f, 1f))
                Cat.ZONING -> colOf(ZONE_SPECS.firstOrNull { it.id == id }?.color ?: floatArrayOf(1f, 1f, 1f))
                Cat.SERVICES -> colService(id)
                Cat.INFO -> colOf(INFO_VIEW_COLORS[id] ?: floatArrayOf(1f, 1f, 1f))
                else -> COL_RED
            }
            paint.color = color
            canvas.drawRoundRect(RectF(rPill.left + 12f, rPill.top + 12f, rPill.left + 48f, rPill.bottom - 12f), 8f, 8f, paint)
            val name = when (cat) {
                Cat.ROADS -> ROAD_SPECS.firstOrNull { it.id == id }?.label ?: "Road"
                Cat.ZONING -> ZONE_SPECS.firstOrNull { it.id == id }?.label ?: "Zone"
                Cat.SERVICES -> SERVICE_TYPES[id]?.name ?: "Service"
                Cat.INFO -> INFO_VIEW_LABELS[id] ?: "Info view"
                else -> "Bulldoze"
            }
            text(canvas, name, rPill.left + 60f, rPill.top + 34f, 15f, Color.WHITE, true)
            val sub = when (cat) {
                Cat.ROADS -> "Roads · ${fmtMoney(((ROAD_SPECS.firstOrNull { it.id == id }?.cost ?: 0) * 24).toDouble())} / cell"
                Cat.ZONING -> "Zoning · Free"
                Cat.SERVICES -> "Services · ${fmtMoney((SERVICE_TYPES[id]?.cost ?: 0).toDouble())}"
                Cat.INFO -> "Info Views · Overlay"
                else -> "50 % refund"
            }
            text(canvas, sub, rPill.left + 60f, rPill.top + 60f, 11f, COL_SUB, false)
            text(canvas, "✕", rPill.right - 22f, rPill.centerY() + 5f, 14f, COL_SUB, true, Paint.Align.CENTER)
        }
        glass(canvas, rHints)
        text(canvas, "Drag map • pinch zoom • twist rotate", rHints.centerX(), rHints.centerY() + 5f, 12f,
            COL_SUB, false, Paint.Align.CENTER)
    }

    private fun drawToasts(canvas: Canvas) {
        var y = 856f
        for (i in toasts.indices.reversed()) {
            val (t, c) = toasts[i]
            val r = RectF(650f, y - 34f, 1270f, y)
            paint.color = Color.argb(226, 13, 21, 29)
            canvas.drawRoundRect(r, 10f, 10f, paint)
            paint.color = c
            canvas.drawRoundRect(RectF(r.left, r.top, r.left + 5f, r.bottom), 2.5f, 2.5f, paint)
            text(canvas, t, r.centerX(), r.centerY() + 5f, 13f, Color.WHITE, false, Paint.Align.CENTER)
            y -= 46f
        }
    }

    private fun drawMessage(canvas: Canvas) {
        if (messageTime <= 0f) return
        glass(canvas, rMessage)
        text(canvas, message, 46f, 942f, 14f, Color.WHITE, true)
        text(canvas, "Drag map • pinch zoom • twist rotate", 46f, 972f, 10f, COL_SUB, false)
    }

    private fun drawInfoPanel(canvas: Canvas) {
        val lines = infoLines ?: return
        val r = infoPanelRect(lines.size)
        glass(canvas, r)
        lines.forEachIndexed { i, line ->
            if (i == 0) text(canvas, line, 46f, 152f, 16f, Color.WHITE, true)
            else text(canvas, line, 46f, 152f + i * 24f, 13f, COL_SUB, false)
        }
        text(canvas, "✕", r.right - 24f, r.top + 34f, 15f, COL_SUB, true, Paint.Align.CENTER)
    }

    private fun drawNotifSheet(canvas: Canvas) {
        glass(canvas, rSheetNotif, stroke = COL_GOLD)
        text(canvas, "Notifications", 1304f, 158f, 18f, Color.WHITE, true)
        if (unread > 0) text(canvas, "$unread unread", 1560f, 158f, 12f, COL_RED, true)
        text(canvas, "✕", rSheetNotif.right - 36f, rSheetNotif.top + 38f, 16f, COL_SUB, true, Paint.Align.CENTER)
        var y = 200f
        text(canvas, "ACTIVE ISSUES", 1304f, y, 11f, COL_SUB, true)
        y += 24f
        val gv = gameView
        val alerts = gv?.renderer?.activeAlerts() ?: emptyList()
        if (alerts.isEmpty()) text(canvas, "All services are keeping up.", 1316f, y, 13f, COL_GREEN, false)
        else for (a in alerts.take(6)) {
            paint.color = COL_AMBER
            canvas.drawCircle(1316f, y - 4f, 4f, paint)
            text(canvas, alertLabel(a), 1330f, y, 13f, Color.WHITE, false)
            y += 24f
        }
        y += 14f
        paint.color = Color.argb(40, 255, 255, 255)
        canvas.drawLine(1304f, y, 1868f, y, paint)
        y += 26f
        text(canvas, "HISTORY", 1304f, y, 11f, COL_SUB, true)
        y += 24f
        if (notifs.isEmpty()) text(canvas, "Milestones, budget reports and warnings collect here.", 1316f, y, 12f, COL_SUB, false)
        else for (n in notifs.reversed()) {
            if (y > rSheetNotif.bottom - 20f) break
            val tag = when (n.kind) { "milestone" -> "★"; "alert" -> "!"; else -> "·" }
            paint.color = when (n.kind) { "milestone" -> COL_GOLD; "alert" -> COL_UPKEEP; else -> COL_SUB }
            text(canvas, tag, 1316f, y, 13f, paint.color, true)
            text(canvas, n.text, 1338f, y, 13f, Color.WHITE, false)
            text(canvas, "Day ${n.day}", 1868f, y, 11f, COL_SUB, false, Paint.Align.RIGHT)
            y += 24f
        }
    }

    private fun alertLabel(key: String) = when (key) {
        "power" -> "No power — buildings are dark"
        "water" -> "Water shortage"
        "sewage" -> "Sewage backup"
        "garbage" -> "Garbage piling up"
        "health" -> "Healthcare strained"
        "education" -> "Schools overcrowded"
        "safety" -> "Police / fire coverage low"
        "unemployment" -> "High unemployment"
        "jobs" -> "Not enough workers"
        "happiness" -> "Citizens are unhappy"
        "deficit" -> "Budget deficit"
        "bankrupt" -> "TREASURY EMPTY"
        else -> key
    }

    private fun drawSettingsSheet(canvas: Canvas) {
        val gv = gameView ?: return
        glass(canvas, rSheetSettings, stroke = COL_CYAN)
        text(canvas, "Settings", 1304f, 158f, 18f, Color.WHITE, true)
        text(canvas, "✕", rSheetSettings.right - 36f, rSheetSettings.top + 38f, 16f, COL_SUB, true, Paint.Align.CENTER)
        // weather
        text(canvas, "WEATHER", 1304f, 200f, 11f, COL_SUB, true)
        val cur = gv.renderer.weatherName()
        for ((i, w) in WEATHER_PRESETS.withIndex()) {
            val r = weatherRect(i)
            paint.color = if (w == cur) Color.argb(90, 151, 210, 233) else Color.argb(30, 255, 255, 255)
            canvas.drawRoundRect(r, 9f, 9f, paint)
            if (w == cur) { paint.style = Paint.Style.STROKE; paint.strokeWidth = 2f; paint.color = COL_CYAN
                canvas.drawRoundRect(r, 9f, 9f, paint); paint.style = Paint.Style.FILL }
            text(canvas, w.uppercase(), r.centerX(), r.centerY() + 4f, 11f, Color.WHITE, true, Paint.Align.CENTER)
        }
        // time of day
        text(canvas, "TIME OF DAY — DRAG TO STAGE A SCREENSHOT", 1304f, 302f, 11f, COL_SUB, true)
        paint.color = Color.argb(45, 255, 255, 255)
        canvas.drawRoundRect(rSlider, 8f, 8f, paint)
        val hour = gv.renderer.hour
        val fx = rSlider.left + rSlider.width() * (hour / 24f)
        paint.color = Color.argb(110, 151, 210, 233)
        canvas.drawRoundRect(RectF(rSlider.left, rSlider.top, fx, rSlider.bottom), 8f, 8f, paint)
        paint.color = COL_GOLD
        canvas.drawCircle(fx, rSlider.centerY(), 10f, paint)
        val h = hour.toInt().coerceIn(0, 23)
        val m = ((hour - hour.toInt()) * 60f).toInt()
        text(canvas, "${String.format("%02d:%02d", h, m)} · ${dayPhase(hour)}", 1304f, 380f, 13f, Color.WHITE, true)
        // hide hud
        text(canvas, "Hide HUD (cinematic mode)", 1304f, 442f, 14f, Color.WHITE, false)
        paint.color = if (hudHidden) COL_CYAN else Color.argb(50, 255, 255, 255)
        canvas.drawRoundRect(rToggleHide, 20f, 20f, paint)
        paint.color = Color.WHITE
        canvas.drawCircle(if (hudHidden) rToggleHide.right - 20f else rToggleHide.left + 20f, rToggleHide.centerY(), 15f, paint)
        // rename row
        paint.color = Color.argb(30, 255, 255, 255)
        canvas.drawRoundRect(rRowRename, 10f, 10f, paint)
        text(canvas, "City name", 1304f, 502f, 14f, Color.WHITE, false)
        text(canvas, "${gv.renderer.cityName()} ›", 1868f, 502f, 13f, COL_CYAN, false, Paint.Align.RIGHT)
        // web parity row
        paint.color = Color.argb(30, 255, 255, 255)
        canvas.drawRoundRect(rRowWeb, 10f, 10f, paint)
        text(canvas, "Web-parity build (1:1 web game)", 1304f, 562f, 14f, Color.WHITE, false)
        text(canvas, "Open ›", 1868f, 562f, 13f, COL_CYAN, false, Paint.Align.RIGHT)
        // quality row (static — the native renderer runs one tuned tier)
        text(canvas, "Quality", 1304f, 622f, 14f, Color.WHITE, false)
        text(canvas, "High (device default)", 1868f, 622f, 13f, COL_SUB, false, Paint.Align.RIGHT)
        // shortcuts note
        text(canvas, "Touch: 1 finger — tools & UI • 2 fingers — camera (pan / pinch / twist) • Back — cancel", 1304f, 668f, 12f, COL_SUB, false)
    }

    // ---------------------------------------------------------------- helpers

    private fun glass(canvas: Canvas, rect: RectF, stroke: Int = Color.argb(75, 151, 210, 233)) {
        paint.style = Paint.Style.FILL
        paint.color = Color.argb(218, 13, 21, 29)
        canvas.drawRoundRect(rect, 18f, 18f, paint)
        paint.color = stroke
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 2f
        canvas.drawRoundRect(rect, 18f, 18f, paint)
        paint.style = Paint.Style.FILL
    }

    private fun text(canvas: Canvas, value: String, x: Float, y: Float, size: Float, color: Int, bold: Boolean, align: Paint.Align = Paint.Align.LEFT) {
        paint.color = color
        paint.textSize = size
        paint.typeface = if (bold) android.graphics.Typeface.DEFAULT_BOLD else android.graphics.Typeface.DEFAULT
        paint.textAlign = align
        canvas.drawText(value, x, y, paint)
    }

    fun pauseHud() {
        running = false
    }

    fun resumeHud() {
        if (!running) {
            running = true
            lastFrameNanos = 0L
            postOnAnimation(frameCallback)
        }
        invalidate()
    }
}
