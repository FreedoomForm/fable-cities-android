package com.fablecities.android

import android.content.Context

/** Persistent state for the native vertical slice; kept separate from rendering for later system ports. */
data class CityState(
    var money: Int = 125_000,
    var population: Int = 240,
    var day: Int = 1,
    var hour: Float = 8f,
    var selectedTool: String = "SELECT"
) {
    fun save(context: Context) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit()
            .putInt("money", money)
            .putInt("population", population)
            .putInt("day", day)
            .putFloat("hour", hour)
            .putString("selectedTool", selectedTool)
            .apply()
    }

    companion object {
        private const val FILE = "fable_cities_city"

        fun load(context: Context): CityState {
            val prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            return CityState(
                money = prefs.getInt("money", 125_000),
                population = prefs.getInt("population", 240),
                day = prefs.getInt("day", 1),
                hour = prefs.getFloat("hour", 8f),
                selectedTool = prefs.getString("selectedTool", "SELECT") ?: "SELECT"
            )
        }
    }
}
