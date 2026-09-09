package com.fablecities.android

/**
 * The site's HUD catalogue (src/modules/ui/catalog.js) mirrored for the native UI and the
 * renderer's tool plumbing. Costs/upkeep/labels are the site's display values; service ids and
 * costs mirror worldgen.Simulation.SERVICE_TYPES (services.js) so placing receives the same ids
 * the tray shows.
 */

/** ROAD_TYPES (catalog.js) + economy.js ROAD_COST weekly upkeep. Width clamped to the 24 m cell. */
class RoadSpec(
    val id: String, val label: String, val short: String,
    val cost: Int,          // build ¤ per metre (catalog)
    val upkeep: Double,     // ¤ per metre per week (economy ROAD_COST)
    val widthM: Float,      // metres, clamped into the cell
    val color: FloatArray,  // tray chip + UI accent
    val asphalt: FloatArray // mesh colour
)

val ROAD_SPECS = listOf(
    RoadSpec("local", "Two-Lane Road", "Local", 180, 0.30, 12f,
        floatArrayOf(0.83f, 0.86f, 0.90f), floatArrayOf(0.115f, 0.12f, 0.135f)),
    RoadSpec("avenue", "Four-Lane Avenue", "Avenue", 420, 0.64, 24f,
        floatArrayOf(0.56f, 0.82f, 1.00f), floatArrayOf(0.100f, 0.110f, 0.130f)),
    RoadSpec("highway", "Highway", "Highway", 900, 1.01, 22f,
        floatArrayOf(1.00f, 0.70f, 0.36f), floatArrayOf(0.090f, 0.095f, 0.110f)),
    RoadSpec("path", "Pedestrian Path", "Path", 60, 0.07, 3f,
        floatArrayOf(0.62f, 0.89f, 0.56f), floatArrayOf(0.620f, 0.550f, 0.420f)),
)

/** ZONE_LABELS / ZONE_COLORS (catalog.js), ids in painting order. */
class ZoneSpec(val id: String, val label: String, val short: String, val color: FloatArray, val hex: String)

val ZONE_SPECS = listOf(
    ZoneSpec("res-low", "Low Density Residential", "Residential · Low",
        floatArrayOf(0.56f, 0.85f, 0.35f), "#8fd95a"),
    ZoneSpec("res-high", "High Density Residential", "Residential · High",
        floatArrayOf(0.18f, 0.66f, 0.44f), "#2ea86f"),
    ZoneSpec("com-low", "Low Density Commercial", "Commercial · Low",
        floatArrayOf(0.38f, 0.78f, 1.00f), "#62c6ff"),
    ZoneSpec("com-high", "High Density Commercial", "Commercial · High",
        floatArrayOf(0.17f, 0.43f, 0.86f), "#2b6fdc"),
    ZoneSpec("ind", "Industrial", "Industrial",
        floatArrayOf(0.95f, 0.71f, 0.20f), "#f1b634"),
    ZoneSpec("office", "Office", "Office",
        floatArrayOf(0.71f, 0.49f, 0.94f), "#b57cf0"),
)

/** INFO_VIEWS keys (catalog.js) — the overlay slice wires the data; the tray already lists them. */
val INFO_VIEW_IDS = listOf("traffic", "landvalue", "pollution", "happiness", "power", "water", "zoning")
val INFO_VIEW_LABELS = mapOf(
    "traffic" to "Traffic Flow", "landvalue" to "Land Value", "pollution" to "Pollution",
    "happiness" to "Happiness", "power" to "Electricity", "water" to "Water & Sewage",
    "zoning" to "Zoning",
)
val INFO_VIEW_COLORS = mapOf(
    "traffic" to floatArrayOf(1.00f, 0.54f, 0.40f), "landvalue" to floatArrayOf(1.00f, 0.84f, 0.42f),
    "pollution" to floatArrayOf(0.71f, 0.55f, 1.00f), "happiness" to floatArrayOf(0.44f, 0.88f, 0.55f),
    "power" to floatArrayOf(0.96f, 0.73f, 0.26f), "water" to floatArrayOf(0.31f, 0.76f, 0.97f),
    "zoning" to floatArrayOf(0.56f, 0.85f, 0.35f),
)

/** The site's five weather presets (settings.js / catalog.js WEATHERS). */
val WEATHER_PRESETS = listOf("clear", "cloudy", "rain", "fog", "snow")

/** The site's world starts 1 May 2026 (World.js time init, weekday recomputed by the clock). */
val WORLD_EPOCH = java.time.LocalDate.of(2026, 5, 1)

/** fmtMoney (dom.js): ₡ sign, thousands separators, explicit minus, optional + sign. */
fun fmtMoney(v: Double, sign: Boolean = false): String {
    val r = Math.round(v)
    val abs = kotlin.math.abs(r)
    val body = String.format(java.util.Locale.US, "%,d", abs)
    val s = when {
        r < 0 -> "\u2212"
        sign -> "+"
        else -> ""
    }
    return s + "\u20A1" + body
}

/** dayPhase (topbar.js). */
fun dayPhase(hour: Float): String = when {
    hour < 5f -> "Night"
    hour < 7f -> "Dawn"
    hour < 11.5f -> "Morning"
    hour < 13.5f -> "Noon"
    hour < 17.5f -> "Afternoon"
    hour < 19.5f -> "Evening"
    hour < 21f -> "Dusk"
    else -> "Night"
}

/** Population tiers (topbar.js TIERS) for the badge when no milestone name applies. */
fun populationTier(pop: Int): String {
    var t = "Founding"
    val tiers = listOf(0 to "Founding", 120 to "Tiny Village", 1000 to "Large Village", 4000 to "Tiny Town",
        11000 to "Busy Town", 24000 to "Great Town", 50000 to "Big City", 100000 to "Grand City",
        150000 to "Metropolis", 250000 to "Megalopolis")
    for ((min, name) in tiers) if (pop >= min) t = name
    return t
}
