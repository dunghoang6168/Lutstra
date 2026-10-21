package com.lutstra.android;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Parses and keeps the EQ spec the web sends, within the limits the host also enforces on desktop. */
final class EqSettingsStore {
    private static final String PREFS = "lutstra-eq";
    private static final String KEY = "spec";
    private static final int MAX_FILTERS = 32;

    private EqSettingsStore() {}

    static EqDsp.Spec parse(JSONObject json) throws JSONException {
        double preampDb = number(json, "preampDb", -24, 12);
        double crossfeed = json.has("crossfeed") ? number(json, "crossfeed", 0, 1) : 0;
        JSONArray list = json.optJSONArray("filters");
        int count = list == null ? 0 : list.length();
        if (count > MAX_FILTERS) throw new IllegalArgumentException("Too many EQ filters");
        EqDsp.Filter[] filters = new EqDsp.Filter[count];
        for (int i = 0; i < count; i++) {
            JSONObject filter = list.getJSONObject(i);
            String type = filter.optString("type", "peak");
            int kind = "lowshelf".equals(type) ? EqDsp.LOW_SHELF : "highshelf".equals(type) ? EqDsp.HIGH_SHELF
                : "peak".equals(type) ? EqDsp.PEAK : -1;
            if (kind < 0) throw new IllegalArgumentException("Unknown EQ filter type " + type);
            filters[i] = new EqDsp.Filter(kind, number(filter, "freq", 10, 24000), number(filter, "gainDb", -30, 30), number(filter, "q", 0.1, 10));
        }
        return new EqDsp.Spec(preampDb, filters, crossfeed);
    }

    private static double number(JSONObject json, String key, double min, double max) throws JSONException {
        double value = json.getDouble(key);
        if (!Double.isFinite(value) || value < min || value > max) throw new IllegalArgumentException("EQ " + key + " out of range");
        return value;
    }

    static void save(Context context, JSONObject json) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, json.toString()).apply();
    }

    static void load(Context context) {
        String saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null);
        if (saved == null) return;
        try {
            EqDsp.spec = parse(new JSONObject(saved));
        } catch (JSONException | IllegalArgumentException ignored) {
            // A spec that no longer parses is dropped; the web sends a fresh one when it starts.
            EqDsp.spec = EqDsp.Spec.FLAT;
        }
    }
}
