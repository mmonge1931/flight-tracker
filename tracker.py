#!/usr/bin/env python3
"""
Rastreador de precios de vuelos SJO -> MEX (Día de Muertos 2027).

Sin dependencias externas: usa únicamente la biblioteca estándar de Python 3.9+.
Consulta SerpApi (Google Flights), guarda histórico en JSON/CSV, alimenta el
tablero web en docs/ y envía alertas/resúmenes semanales a Telegram.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import math
import os
import random
import statistics
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
DATA_DIR = BASE_DIR / "data"
DOCS_DATA_DIR = BASE_DIR / "docs" / "data"
PRICES_JSON_PATH = DATA_DIR / "prices.json"
PRICES_CSV_PATH = DATA_DIR / "prices.csv"
DOCS_PRICES_JSON_PATH = DOCS_DATA_DIR / "prices.json"
DOCS_PRICES_JS_PATH = DOCS_DATA_DIR / "prices.js"

# Costa Rica mantiene UTC-6 todo el año (sin horario de verano)
CR_TZ = timezone(timedelta(hours=-6))

WEEKDAY_MAP = {
    "monday": 0,
    "lunes": 0,
    "tuesday": 1,
    "martes": 1,
    "wednesday": 2,
    "miercoles": 2,
    "miércoles": 2,
    "thursday": 3,
    "jueves": 3,
    "friday": 4,
    "viernes": 4,
    "saturday": 5,
    "sabado": 5,
    "sábado": 5,
    "sunday": 6,
    "domingo": 6,
}

PRICE_LEVEL_LABELS = {
    "low": "Bajo",
    "typical": "Típico",
    "high": "Alto",
}

PRICE_LEVEL_EMOJIS = {
    "low": "🟢",
    "typical": "🟡",
    "high": "🔴",
}


def load_dotenv(env_path: Path) -> None:
    """Carga variables de un archivo .env local sin sobreescribir el entorno."""
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def load_config() -> Dict[str, Any]:
    if not CONFIG_PATH.exists():
        raise FileNotFoundError(f"No se encontró el archivo de configuración: {CONFIG_PATH}")
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def now_cr() -> datetime:
    return datetime.now(CR_TZ)


def format_currency(amount: Optional[float], symbol: str = "₡") -> str:
    if amount is None:
        return "N/D"
    return f"{symbol}{int(round(amount)):,}"


def format_duration(minutes: Optional[int]) -> str:
    if not minutes or minutes <= 0:
        return "N/D"
    hours, mins = divmod(int(minutes), 60)
    return f"{hours}h {mins:02d}m"


def format_stops(stops: Optional[int]) -> str:
    if stops is None:
        return "N/D"
    if stops == 0:
        return "Directo"
    if stops == 1:
        return "1 escala"
    return f"{stops} escalas"


def fallback_google_flights_url(
    origin: str,
    destination: str,
    outbound_date: str,
    return_date: str,
    currency: str = "CRC",
    hl: str = "es",
) -> str:
    query = f"Flights to {destination} from {origin} on {outbound_date} through {return_date}"
    params = urllib.parse.urlencode({"q": query, "curr": currency, "hl": hl})
    return f"https://www.google.com/travel/flights?{params}"


def parse_iso_date(date_str: str) -> date:
    return date.fromisoformat(date_str)


def calc_nights(outbound_date: str, return_date: str) -> int:
    return (parse_iso_date(return_date) - parse_iso_date(outbound_date)).days


def http_get_json(url: str, timeout: int = 30) -> Tuple[int, Dict[str, Any]]:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "cdmx-flight-tracker/1.0"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, json.loads(body)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"error": raw or f"HTTP {exc.code}"}
        return exc.code, payload
    except urllib.error.URLError as exc:
        return 0, {"error": f"Error de conexión: {exc.reason}"}


def http_post_json(url: str, payload: Dict[str, Any], timeout: int = 20) -> Tuple[int, Dict[str, Any]]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "cdmx-flight-tracker/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, json.loads(body)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {"error": raw or f"HTTP {exc.code}"}
        return exc.code, parsed
    except urllib.error.URLError as exc:
        return 0, {"error": f"Error de conexión: {exc.reason}"}


def normalize_itinerary(item: Dict[str, Any], adults: int, is_best: bool) -> Optional[Dict[str, Any]]:
    price = item.get("price")
    if price is None or not isinstance(price, (int, float)) or price <= 0:
        return None

    segments = item.get("flights") or []
    airlines: List[str] = []
    for seg in segments:
        airline = seg.get("airline")
        if airline and airline not in airlines:
            airlines.append(str(airline))

    stops = max(0, len(segments) - 1) if segments else None
    layovers = [
        str(lay.get("name") or lay.get("id") or "")
        for lay in (item.get("layovers") or [])
        if lay.get("name") or lay.get("id")
    ]

    dep_time = ""
    arr_time = ""
    if segments:
        dep_time = str((segments[0].get("departure_airport") or {}).get("time") or "")
        arr_time = str((segments[-1].get("arrival_airport") or {}).get("time") or "")

    total_price = int(round(price))
    per_person = int(round(total_price / max(1, adults)))

    return {
        "price": total_price,
        "price_per_person": per_person,
        "airlines": airlines or ["Aerolínea N/D"],
        "airline_summary": " + ".join(airlines) if airlines else "N/D",
        "stops": stops,
        "total_duration_min": item.get("total_duration"),
        "departure_time": dep_time,
        "arrival_time": arr_time,
        "layovers": layovers,
        "is_best": is_best,
    }


def fetch_google_flights(
    api_key: str,
    origin: str,
    destination: str,
    outbound_date: str,
    return_date: str,
    adults: int = 2,
    currency: str = "CRC",
    gl: str = "cr",
    hl: str = "es",
) -> Dict[str, Any]:
    """Consulta SerpApi (engine=google_flights) y normaliza los resultados."""
    params = {
        "engine": "google_flights",
        "departure_id": origin,
        "arrival_id": destination,
        "type": "1",  # 1 = ida y vuelta (round trip)
        "outbound_date": outbound_date,
        "return_date": return_date,
        "adults": str(adults),
        "currency": currency,
        "gl": gl,
        "hl": hl,
        "api_key": api_key,
    }
    url = f"https://serpapi.com/search.json?{urllib.parse.urlencode(params)}"
    status_code, raw = http_get_json(url)
    fallback_url = fallback_google_flights_url(
        origin, destination, outbound_date, return_date, currency, hl
    )

    if status_code != 200 or "error" in raw:
        err_msg = str(raw.get("error") or f"Error HTTP {status_code}")
        err_lower = err_msg.lower()
        # Si Google Flights aún no tiene fechas publicadas, clasificarlo limpiamente
        unavailable_hints = (
            "hasn't returned any results",
            "no results",
            "too far",
            "invalid date",
            "out of range",
        )
        if any(hint in err_lower for hint in unavailable_hints):
            return {
                "status": "unavailable",
                "status_message": "Aún no hay vuelos publicados en Google Flights para estas fechas.",
                "google_flights_url": fallback_url,
            }
        return {
            "status": "error",
            "status_message": f"Error al consultar SerpApi: {err_msg}",
            "google_flights_url": fallback_url,
        }

    search_meta = raw.get("search_metadata") or {}
    gf_url = search_meta.get("google_flights_url") or fallback_url

    itineraries: List[Dict[str, Any]] = []
    for item in raw.get("best_flights") or []:
        norm = normalize_itinerary(item, adults, is_best=True)
        if norm:
            itineraries.append(norm)
    for item in raw.get("other_flights") or []:
        norm = normalize_itinerary(item, adults, is_best=False)
        if norm:
            itineraries.append(norm)

    if not itineraries:
        return {
            "status": "unavailable",
            "status_message": "No se encontraron tarifas disponibles todavía para estas fechas.",
            "google_flights_url": gf_url,
        }

    itineraries.sort(key=lambda x: (x["price"], x["total_duration_min"] or 99999))
    best_overall = itineraries[0]
    nonstop_list = [f for f in itineraries if f["stops"] == 0]
    best_nonstop = nonstop_list[0] if nonstop_list else None

    raw_insights = raw.get("price_insights") or {}
    typical_range = raw_insights.get("typical_price_range")
    if not (isinstance(typical_range, list) and len(typical_range) == 2):
        typical_range = None

    raw_history = raw_insights.get("price_history") or []
    clean_history: List[List[Any]] = []
    for pair in raw_history:
        if (
            isinstance(pair, list)
            and len(pair) >= 2
            and isinstance(pair[0], (int, float))
            and isinstance(pair[1], (int, float))
            and pair[1] > 0
        ):
            clean_history.append([int(pair[0]), int(round(pair[1]))])

    price_insights = {
        "lowest_price": raw_insights.get("lowest_price") or best_overall["price"],
        "price_level": raw_insights.get("price_level"),
        "typical_price_range": typical_range,
        "price_history": clean_history,
    }

    return {
        "status": "available",
        "status_message": f"{len(itineraries)} opciones encontradas.",
        "best_overall": best_overall,
        "best_nonstop": best_nonstop,
        "top_flights": itineraries[:6],
        "price_insights": price_insights,
        "google_flights_url": gf_url,
    }


def load_existing_data() -> Dict[str, Any]:
    if not PRICES_JSON_PATH.exists():
        return {"meta": {}, "windows": {}}
    try:
        return json.loads(PRICES_JSON_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"meta": {}, "windows": {}}


def compute_window_stats(history: List[Dict[str, Any]]) -> Dict[str, Any]:
    available = [h for h in history if h.get("status") == "available" and h.get("best_overall_price")]
    if not available:
        return {
            "samples": 0,
            "min_overall": None,
            "min_overall_date": None,
            "max_overall": None,
            "avg_overall": None,
            "min_nonstop": None,
            "min_nonstop_date": None,
            "previous_overall": None,
            "delta_crc": None,
            "delta_pct": None,
        }

    overall_prices = [h["best_overall_price"] for h in available]
    min_overall_entry = min(available, key=lambda h: h["best_overall_price"])

    nonstop_entries = [h for h in available if h.get("best_nonstop_price")]
    min_nonstop_entry = (
        min(nonstop_entries, key=lambda h: h["best_nonstop_price"]) if nonstop_entries else None
    )

    latest = available[-1]
    prev = available[-2] if len(available) >= 2 else None
    delta_crc = None
    delta_pct = None
    if prev and prev.get("best_overall_price"):
        delta_crc = latest["best_overall_price"] - prev["best_overall_price"]
        delta_pct = round((delta_crc / prev["best_overall_price"]) * 100, 1)

    return {
        "samples": len(available),
        "min_overall": min_overall_entry["best_overall_price"],
        "min_overall_date": min_overall_entry["date"],
        "max_overall": max(overall_prices),
        "avg_overall": int(round(statistics.mean(overall_prices))),
        "min_nonstop": min_nonstop_entry["best_nonstop_price"] if min_nonstop_entry else None,
        "min_nonstop_date": min_nonstop_entry["date"] if min_nonstop_entry else None,
        "previous_overall": prev["best_overall_price"] if prev else None,
        "delta_crc": delta_crc,
        "delta_pct": delta_pct,
    }


def upsert_history_entry(history: List[Dict[str, Any]], entry: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Mantiene un registro por día calendario (actualizando si ya se corrió hoy)."""
    filtered = [h for h in history if h.get("date") != entry["date"]]
    filtered.append(entry)
    filtered.sort(key=lambda h: h["date"])
    return filtered


def save_outputs(data: Dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DOCS_DATA_DIR.mkdir(parents=True, exist_ok=True)

    json_text = json.dumps(data, ensure_ascii=False, indent=2)
    PRICES_JSON_PATH.write_text(json_text, encoding="utf-8")
    DOCS_PRICES_JSON_PATH.write_text(json_text, encoding="utf-8")

    # También generamos prices.js para que docs/index.html funcione al abrirse local con doble clic
    js_text = f"window.FLIGHT_DATA = {json_text};\n"
    DOCS_PRICES_JS_PATH.write_text(js_text, encoding="utf-8")

    # Exportar histórico plano a CSV para abrir fácilmente en Excel o Google Sheets
    rows: List[Dict[str, Any]] = []
    for win_id, win in data.get("windows", {}).items():
        for h in win.get("history", []):
            rows.append(
                {
                    "fecha_escaneo": h.get("date"),
                    "opcion_id": win_id,
                    "opcion": win.get("label"),
                    "salida": win.get("outbound_date"),
                    "regreso": win.get("return_date"),
                    "estado": h.get("status"),
                    "precio_total_crc": h.get("best_overall_price") or "",
                    "precio_persona_crc": h.get("best_overall_per_person") or "",
                    "aerolinea_mejor": h.get("best_overall_airline") or "",
                    "escalas_mejor": h.get("best_overall_stops")
                    if h.get("best_overall_stops") is not None
                    else "",
                    "precio_directo_total_crc": h.get("best_nonstop_price") or "",
                    "aerolinea_directo": h.get("best_nonstop_airline") or "",
                    "nivel_google": h.get("price_level") or "",
                }
            )
    rows.sort(key=lambda r: (r["fecha_escaneo"], r["opcion_id"]))

    fieldnames = [
        "fecha_escaneo",
        "opcion_id",
        "opcion",
        "salida",
        "regreso",
        "estado",
        "precio_total_crc",
        "precio_persona_crc",
        "aerolinea_mejor",
        "escalas_mejor",
        "precio_directo_total_crc",
        "aerolinea_directo",
        "nivel_google",
    ]
    with PRICES_CSV_PATH.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def evaluate_alerts(
    config: Dict[str, Any],
    window_id: str,
    window_label: str,
    prev_history: List[Dict[str, Any]],
    new_result: Dict[str, Any],
) -> List[str]:
    """Evalúa si el resultado de hoy dispara una alerta inmediata."""
    alerts_cfg = config.get("alerts") or {}
    symbol = config.get("currency_symbol", "₡")
    reasons: List[str] = []

    if new_result.get("status") != "available":
        return reasons

    best = new_result.get("best_overall") or {}
    price = best.get("price")
    if not price:
        return reasons

    prev_available = [
        h for h in prev_history if h.get("status") == "available" and h.get("best_overall_price")
    ]

    # 1. Primera vez que aparecen vuelos disponibles para esta fecha
    if alerts_cfg.get("first_availability_alert", True) and not prev_available:
        reasons.append(
            f"🎉 <b>¡Ya salieron vuelos!</b> {html.escape(window_label)} ahora muestra tarifas desde {format_currency(price, symbol)}."
        )
        return reasons

    if prev_available:
        prev_prices = [h["best_overall_price"] for h in prev_available]
        prev_min = min(prev_prices)
        last_price = prev_available[-1]["best_overall_price"]

        # 2. Nuevo mínimo histórico
        if alerts_cfg.get("new_record_low_alert", True) and price < prev_min:
            diff = prev_min - price
            reasons.append(
                f"🔥 <b>Nuevo mínimo histórico</b> en {html.escape(window_label)}: "
                f"{format_currency(price, symbol)} (bajó {format_currency(diff, symbol)} respecto al récord anterior)."
            )

        # 3. Caída porcentual notable respecto al último escaneo
        drop_pct_threshold = float(alerts_cfg.get("drop_alert_percent", 5))
        if last_price > 0 and price < last_price:
            drop_pct = ((last_price - price) / last_price) * 100
            if drop_pct >= drop_pct_threshold:
                reasons.append(
                    f"📉 <b>Bajada de {drop_pct:.1f}%</b> en {html.escape(window_label)}: "
                    f"de {format_currency(last_price, symbol)} a {format_currency(price, symbol)}."
                )

    # 4. Meta de precio personalizada
    target_price = alerts_cfg.get("target_price_crc")
    if target_price and price <= float(target_price):
        reasons.append(
            f"🎯 <b>Debajo de tu meta</b> en {html.escape(window_label)}: "
            f"{format_currency(price, symbol)} (meta: {format_currency(target_price, symbol)})."
        )

    return reasons


def build_telegram_message(
    config: Dict[str, Any],
    data: Dict[str, Any],
    alert_reasons: List[str],
    is_weekly: bool,
    is_forced: bool,
) -> str:
    symbol = config.get("currency_symbol", "₡")
    adults = int(config.get("adults", 2))
    trip_name = html.escape(config.get("trip_name", "Rastreador de Vuelos"))

    if alert_reasons:
        header = f"🚨 <b>Alerta de Vuelos · {trip_name}</b>"
    elif is_weekly:
        header = f"📊 <b>Resumen Semanal · {trip_name}</b>"
    elif is_forced:
        header = f"✈️ <b>Reporte Manual · {trip_name}</b>"
    else:
        header = f"✈️ <b>Reporte de Vuelos · {trip_name}</b>"

    lines = [
        header,
        f"🛫 {html.escape(config['origin'])} → {html.escape(config['destination'])} · {adults} adultos · {data['meta']['last_updated_display']}",
        "",
    ]

    if alert_reasons:
        lines.append("<b>Novedades importantes:</b>")
        for r in alert_reasons:
            lines.append(f"• {r}")
        lines.append("")

    for win_cfg in config.get("date_windows", []):
        win_id = win_cfg["id"]
        win = (data.get("windows") or {}).get(win_id)
        if not win:
            continue

        label = html.escape(win["label"])
        date_range = f"{win['outbound_date']} → {win['return_date']} ({win['nights']} noches)"
        lines.append(f"<b>{label}</b>")
        lines.append(f"📅 {date_range}")

        status = win.get("status")
        if status != "available":
            lines.append(f"⏳ <i>{html.escape(win.get('status_message') or 'Sin disponibilidad aún.')}</i>")
            lines.append("")
            continue

        latest = win.get("latest") or {}
        best = latest.get("best_overall") or {}
        nonstop = latest.get("best_nonstop")
        insights = latest.get("price_insights") or {}
        stats = win.get("stats") or {}

        total_str = format_currency(best.get("price"), symbol)
        per_str = format_currency(best.get("price_per_person"), symbol)
        airline = html.escape(best.get("airline_summary", "N/D"))
        stops = format_stops(best.get("stops"))
        duration = format_duration(best.get("total_duration_min"))

        level = insights.get("price_level")
        level_badge = ""
        if level in PRICE_LEVEL_LABELS:
            level_badge = f" · {PRICE_LEVEL_EMOJIS[level]} {PRICE_LEVEL_LABELS[level]}"

        delta_str = ""
        if stats.get("delta_crc") is not None and stats["delta_crc"] != 0:
            sign = "+" if stats["delta_crc"] > 0 else ""
            delta_str = f" ({sign}{stats['delta_pct']}%)"

        lines.append(f"💰 Mejor: <b>{total_str}</b> total ({per_str}/persona){delta_str}{level_badge}")
        lines.append(f"   {airline} · {stops} · {duration}")

        if nonstop and best.get("stops") != 0:
            ns_total = format_currency(nonstop.get("price"), symbol)
            ns_airline = html.escape(nonstop.get("airline_summary", "N/D"))
            ns_dur = format_duration(nonstop.get("total_duration_min"))
            lines.append(f"⚡ Directo más barato: <b>{ns_total}</b> ({ns_airline} · {ns_dur})")

        if stats.get("min_overall"):
            lines.append(
                f"📉 Mínimo histórico: {format_currency(stats['min_overall'], symbol)} ({stats['min_overall_date']})"
            )

        gf_url = latest.get("google_flights_url")
        if gf_url:
            lines.append(f'🔗 <a href="{html.escape(gf_url, quote=True)}">Ver en Google Flights</a>')
        lines.append("")

    dashboard_url = (config.get("dashboard_url") or "").strip()
    if dashboard_url:
        lines.append(f'📈 <a href="{html.escape(dashboard_url, quote=True)}">Abrir tablero con gráficas</a>')

    if data.get("meta", {}).get("is_demo"):
        lines.append("<i>⚠️ Mensaje generado con datos de demostración.</i>")

    return "\n".join(lines).strip()


def send_telegram_message(token: str, chat_id: str, text: str) -> bool:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    status, resp = http_post_json(
        url,
        {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        },
    )
    if status == 200 and resp.get("ok"):
        print("✅ Mensaje enviado correctamente a Telegram.")
        return True
    print(f"❌ Error enviando mensaje a Telegram (HTTP {status}): {resp}", file=sys.stderr)
    return False


def cmd_get_chat_id() -> int:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        print("❌ Falta TELEGRAM_BOT_TOKEN en tu archivo .env o variable de entorno.")
        return 1
    url = f"https://api.telegram.org/bot{token}/getUpdates"
    status, resp = http_get_json(url)
    if status != 200 or not resp.get("ok"):
        print(f"❌ No se pudo consultar Telegram: {resp}")
        return 1

    updates = resp.get("result") or []
    if not updates:
        print(
            "ℹ️ Todavía no hay mensajes recibidos por el bot.\n"
            "Envíale un 'Hola' a tu bot en Telegram (o agrega el bot al grupo con tu novia y escribe un mensaje ahí) "
            "y vuelve a correr: python3 tracker.py --get-chat-id"
        )
        return 0

    seen = {}
    for upd in updates:
        msg = upd.get("message") or upd.get("my_chat_member") or {}
        chat = msg.get("chat") or {}
        cid = chat.get("id")
        if cid is not None:
            title = chat.get("title") or f"{chat.get('first_name', '')} {chat.get('last_name', '')}".strip()
            ctype = chat.get("type", "unknown")
            seen[cid] = (title or "Sin nombre", ctype)

    print("📱 Chats detectados para tu bot:")
    for cid, (title, ctype) in seen.items():
        print(f"  • Chat ID: {cid}  |  Tipo: {ctype}  |  Nombre: {title}")
    print("\nCopia el Chat ID que prefieras y guárdalo en TELEGRAM_CHAT_ID.")
    return 0


def cmd_test_dates(config: Dict[str, Any]) -> int:
    """Prueba SerpApi hoy mismo usando fechas a ~90 días sin tocar el histórico 2027."""
    api_key = os.environ.get("SERPAPI_KEY", "").strip()
    if not api_key:
        print("❌ Falta SERPAPI_KEY en tu archivo .env o variable de entorno.")
        return 1

    today = now_cr().date()
    sample_out = (today + timedelta(days=90)).isoformat()
    sample_ret = (today + timedelta(days=98)).isoformat()
    symbol = config.get("currency_symbol", "₡")

    print(
        f"🔎 Probando SerpApi en vivo: {config['origin']} → {config['destination']} "
        f"({sample_out} a {sample_ret}, {config['adults']} adultos, {config['currency']})..."
    )
    res = fetch_google_flights(
        api_key=api_key,
        origin=config["origin"],
        destination=config["destination"],
        outbound_date=sample_out,
        return_date=sample_ret,
        adults=int(config.get("adults", 2)),
        currency=config.get("currency", "CRC"),
        gl=config.get("gl", "cr"),
        hl=config.get("hl", "es"),
    )

    if res["status"] != "available":
        print(f"⚠️ Resultado: {res['status']} — {res.get('status_message')}")
        return 1

    best = res["best_overall"]
    nonstop = res.get("best_nonstop")
    insights = res.get("price_insights") or {}
    print("\n✅ ¡Conexión con SerpApi exitosa! (Esto NO modificó tu histórico de 2027)")
    print(
        f"  • Mejor tarifa total ({config['adults']} adultos): "
        f"{format_currency(best['price'], symbol)} ({format_currency(best['price_per_person'], symbol)}/persona)"
    )
    print(
        f"  • Detalle: {best['airline_summary']} · {format_stops(best['stops'])} · "
        f"{format_duration(best['total_duration_min'])}"
    )
    if nonstop:
        print(
            f"  • Directo más barato: {format_currency(nonstop['price'], symbol)} "
            f"({nonstop['airline_summary']} · {format_duration(nonstop['total_duration_min'])})"
        )
    if insights.get("price_level"):
        lvl = PRICE_LEVEL_LABELS.get(insights["price_level"], insights["price_level"])
        print(f"  • Evaluación de Google Flights: {lvl}")
    print(f"  • Enlace: {res['google_flights_url']}")
    return 0


def generate_demo_data(config: Dict[str, Any]) -> Dict[str, Any]:
    """Genera 21 días de datos realistas en colones para previsualizar el tablero."""
    rng = random.Random(20271102)
    today = now_cr()
    adults = int(config.get("adults", 2))

    # Precios base aproximados en colones (total para 2 adultos ida y vuelta SJO <-> MEX)
    base_profiles = {
        "antes-f1": {"base": 442000, "direct_premium": 38000, "typical": [410000, 520000], "level": "low"},
        "clasica-fines": {"base": 538000, "direct_premium": 52000, "typical": [460000, 610000], "level": "high"},
        "post-f1": {"base": 428000, "direct_premium": 32000, "typical": [400000, 510000], "level": "low"},
    }

    windows_data: Dict[str, Any] = {}
    for idx, win_cfg in enumerate(config["date_windows"]):
        win_id = win_cfg["id"]
        prof = base_profiles.get(
            win_id,
            {"base": 465000, "direct_premium": 40000, "typical": [420000, 540000], "level": "typical"},
        )

        history: List[Dict[str, Any]] = []
        current_price = prof["base"] + rng.randint(-12000, 26000)

        for day_offset in range(20, -1, -1):
            d = (today.date() - timedelta(days=day_offset)).isoformat()
            # Simula fluctuaciones realistas con una ligera bajada reciente
            step = rng.randint(-14000, 13000)
            if day_offset < 4:
                step -= 6500
            current_price = max(355000, min(650000, current_price + step))
            rounded_price = int(round(current_price / 1000) * 1000)
            direct_price = rounded_price + (0 if idx == 2 and day_offset == 0 else prof["direct_premium"])
            direct_price = int(round(direct_price / 1000) * 1000)

            best_airline = "Volaris Costa Rica" if rounded_price == direct_price else "Copa Airlines"
            best_stops = 0 if rounded_price == direct_price else 1
            direct_airline = "Volaris Costa Rica" if day_offset % 3 != 0 else "Aeroméxico"

            history.append(
                {
                    "date": d,
                    "status": "available",
                    "best_overall_price": rounded_price,
                    "best_overall_per_person": int(round(rounded_price / adults)),
                    "best_overall_airline": best_airline,
                    "best_overall_stops": best_stops,
                    "best_nonstop_price": direct_price,
                    "best_nonstop_per_person": int(round(direct_price / adults)),
                    "best_nonstop_airline": direct_airline,
                    "price_level": prof["level"],
                }
            )

        last_h = history[-1]
        best_p = last_h["best_overall_price"]
        direct_p = last_h["best_nonstop_price"]

        top_flights = [
            {
                "price": best_p,
                "price_per_person": int(round(best_p / adults)),
                "airlines": [last_h["best_overall_airline"]],
                "airline_summary": last_h["best_overall_airline"],
                "stops": last_h["best_overall_stops"],
                "total_duration_min": 195 if last_h["best_overall_stops"] == 0 else 405,
                "departure_time": f"{win_cfg['outbound_date']} 07:15",
                "arrival_time": f"{win_cfg['outbound_date']} 10:30"
                if last_h["best_overall_stops"] == 0
                else f"{win_cfg['outbound_date']} 14:00",
                "layovers": [] if last_h["best_overall_stops"] == 0 else ["Ciudad de Panamá (PTY)"],
                "is_best": True,
            },
            {
                "price": direct_p,
                "price_per_person": int(round(direct_p / adults)),
                "airlines": ["Volaris Costa Rica"],
                "airline_summary": "Volaris Costa Rica",
                "stops": 0,
                "total_duration_min": 195,
                "departure_time": f"{win_cfg['outbound_date']} 08:40",
                "arrival_time": f"{win_cfg['outbound_date']} 11:55",
                "layovers": [],
                "is_best": True,
            },
            {
                "price": direct_p + 28000,
                "price_per_person": int(round((direct_p + 28000) / adults)),
                "airlines": ["Aeroméxico"],
                "airline_summary": "Aeroméxico",
                "stops": 0,
                "total_duration_min": 200,
                "departure_time": f"{win_cfg['outbound_date']} 14:10",
                "arrival_time": f"{win_cfg['outbound_date']} 17:30",
                "layovers": [],
                "is_best": True,
            },
            {
                "price": direct_p + 49000,
                "price_per_person": int(round((direct_p + 49000) / adults)),
                "airlines": ["Avianca"],
                "airline_summary": "Avianca",
                "stops": 0,
                "total_duration_min": 205,
                "departure_time": f"{win_cfg['outbound_date']} 16:25",
                "arrival_time": f"{win_cfg['outbound_date']} 19:50",
                "layovers": [],
                "is_best": False,
            },
        ]
        # Eliminar duplicado si el más barato ya era el vuelo directo de Volaris
        if best_p == direct_p and last_h["best_overall_stops"] == 0:
            top_flights.pop(1)
        top_flights.sort(key=lambda x: x["price"])

        best_nonstop = next((f for f in top_flights if f["stops"] == 0), None)
        gf_url = fallback_google_flights_url(
            config["origin"],
            config["destination"],
            win_cfg["outbound_date"],
            win_cfg["return_date"],
            config["currency"],
            config["hl"],
        )

        windows_data[win_id] = {
            "id": win_id,
            "label": win_cfg["label"],
            "note": win_cfg["note"],
            "outbound_date": win_cfg["outbound_date"],
            "return_date": win_cfg["return_date"],
            "nights": calc_nights(win_cfg["outbound_date"], win_cfg["return_date"]),
            "color": win_cfg.get("color", "#f59e0b"),
            "status": "available",
            "status_message": f"{len(top_flights)} opciones simuladas.",
            "latest": {
                "date": today.date().isoformat(),
                "timestamp": today.isoformat(),
                "best_overall": top_flights[0],
                "best_nonstop": best_nonstop,
                "top_flights": top_flights,
                "price_insights": {
                    "lowest_price": top_flights[0]["price"],
                    "price_level": prof["level"],
                    "typical_price_range": prof["typical"],
                },
                "google_flights_url": gf_url,
            },
            "stats": compute_window_stats(history),
            "history": history,
        }

    return {
        "meta": {
            "trip_name": config["trip_name"],
            "origin": config["origin"],
            "origin_name": config.get("origin_name", config["origin"]),
            "destination": config["destination"],
            "destination_name": config.get("destination_name", config["destination"]),
            "adults": adults,
            "currency": config["currency"],
            "currency_symbol": config.get("currency_symbol", "₡"),
            "is_demo": True,
            "last_updated_iso": today.isoformat(),
            "last_updated_display": today.strftime("%d/%m/%Y %H:%M (CR)"),
            "total_scans": 21,
            "last_weekly_summary_date": None,
        },
        "windows": windows_data,
    }


def run_scan(config: Dict[str, Any], force_notify: bool, dry_run: bool) -> int:
    api_key = os.environ.get("SERPAPI_KEY", "").strip()
    if not api_key:
        print(
            "❌ No se encontró SERPAPI_KEY.\n"
            "   • Para probar el tablero sin cuenta todavía, corre: python3 tracker.py --demo\n"
            "   • Cuando ya tengas tu llave de SerpApi, guárdala en .env (local) o en GitHub Secrets.",
            file=sys.stderr,
        )
        return 1

    today_dt = now_cr()
    today_date = today_dt.date()
    today_str = today_date.isoformat()
    adults = int(config.get("adults", 2))
    skip_beyond = int((config.get("scan_rules") or {}).get("skip_if_return_beyond_days", 340))

    existing = load_existing_data()
    # Si el archivo anterior era de demostración, empezamos el histórico real limpio
    if existing.get("meta", {}).get("is_demo"):
        print("🧹 Limpiando datos de demostración para iniciar el histórico real...")
        existing = {"meta": {}, "windows": {}}

    prev_windows = existing.get("windows") or {}
    new_windows: Dict[str, Any] = {}
    all_alert_reasons: List[str] = []

    for win_cfg in config["date_windows"]:
        win_id = win_cfg["id"]
        out_date = win_cfg["outbound_date"]
        ret_date = win_cfg["return_date"]
        nights = calc_nights(out_date, ret_date)
        prev_win = prev_windows.get(win_id) or {}
        prev_history = prev_win.get("history") or []

        days_until_return = (parse_iso_date(ret_date) - today_date).days
        print(f"🔎 Revisando {win_cfg['label']} ({out_date} → {ret_date})...")

        if days_until_return > skip_beyond:
            open_date = (parse_iso_date(ret_date) - timedelta(days=skip_beyond)).isoformat()
            result = {
                "status": "too_far",
                "status_message": (
                    f"Faltan {days_until_return} días para el regreso (límite configurado: {skip_beyond}). "
                    f"El escaneo automático iniciará el {open_date} para ahorrar créditos."
                ),
                "google_flights_url": fallback_google_flights_url(
                    config["origin"], config["destination"], out_date, ret_date, config["currency"], config["hl"]
                ),
            }
            print(f"   ⏭️ {result['status_message']}")
        else:
            result = fetch_google_flights(
                api_key=api_key,
                origin=config["origin"],
                destination=config["destination"],
                outbound_date=out_date,
                return_date=ret_date,
                adults=adults,
                currency=config.get("currency", "CRC"),
                gl=config.get("gl", "cr"),
                hl=config.get("hl", "es"),
            )
            if result["status"] == "available":
                p = result["best_overall"]["price"]
                print(
                    f"   ✅ Mejor tarifa: {format_currency(p, config.get('currency_symbol', '₡'))} "
                    f"({result['best_overall']['airline_summary']})"
                )
            else:
                print(f"   ℹ️ {result['status']}: {result['status_message']}")

        # Evaluar alertas ANTES de agregar el registro de hoy al historial
        reasons = evaluate_alerts(config, win_id, win_cfg["label"], prev_history, result)
        all_alert_reasons.extend(reasons)

        best_overall = result.get("best_overall") or {}
        best_nonstop = result.get("best_nonstop") or {}
        insights = result.get("price_insights") or {}

        # Si Google Flights trae historial real (price_history), rellenar días previos faltantes
        merged_history = list(prev_history)
        gf_price_history = insights.get("price_history") or []
        if result["status"] == "available" and gf_price_history and best_overall.get("price"):
            existing_dates = {h.get("date") for h in merged_history}
            last_gf_price = gf_price_history[-1][1]
            scale = 1
            if adults > 1 and last_gf_price > 0:
                ratio = best_overall["price"] / last_gf_price
                if adults * 0.75 <= ratio <= adults * 1.35:
                    scale = adults
            gf_by_date: Dict[str, int] = {}
            for ts, p_val in gf_price_history:
                d_str = datetime.fromtimestamp(ts, tz=CR_TZ).date().isoformat()
                if d_str < today_str and d_str not in existing_dates:
                    gf_by_date[d_str] = int(round(p_val * scale))
            for d_str in sorted(gf_by_date):
                total_p = gf_by_date[d_str]
                merged_history.append(
                    {
                        "date": d_str,
                        "status": "available",
                        "best_overall_price": total_p,
                        "best_overall_per_person": int(round(total_p / max(1, adults))),
                        "best_overall_airline": None,
                        "best_overall_stops": None,
                        "best_nonstop_price": None,
                        "best_nonstop_per_person": None,
                        "best_nonstop_airline": None,
                        "price_level": None,
                        "source": "google_flights",
                    }
                )

        history_entry = {
            "date": today_str,
            "status": result["status"],
            "best_overall_price": best_overall.get("price"),
            "best_overall_per_person": best_overall.get("price_per_person"),
            "best_overall_airline": best_overall.get("airline_summary"),
            "best_overall_stops": best_overall.get("stops"),
            "best_nonstop_price": best_nonstop.get("price"),
            "best_nonstop_per_person": best_nonstop.get("price_per_person"),
            "best_nonstop_airline": best_nonstop.get("airline_summary"),
            "price_level": insights.get("price_level"),
        }

        updated_history = upsert_history_entry(merged_history, history_entry)
        stats = compute_window_stats(updated_history)

        new_windows[win_id] = {
            "id": win_id,
            "label": win_cfg["label"],
            "note": win_cfg["note"],
            "outbound_date": out_date,
            "return_date": ret_date,
            "nights": nights,
            "color": win_cfg.get("color", "#f59e0b"),
            "status": result["status"],
            "status_message": result["status_message"],
            "latest": {
                "date": today_str,
                "timestamp": today_dt.isoformat(),
                "best_overall": result.get("best_overall"),
                "best_nonstop": result.get("best_nonstop"),
                "top_flights": result.get("top_flights") or [],
                "price_insights": insights,
                "google_flights_url": result.get("google_flights_url"),
            },
            "stats": stats,
            "history": updated_history,
        }

    prev_meta = existing.get("meta") or {}
    weekly_day_name = str((config.get("alerts") or {}).get("weekly_summary_weekday", "monday")).lower()
    weekly_weekday = WEEKDAY_MAP.get(weekly_day_name, 0)
    is_weekly = (
        today_date.weekday() == weekly_weekday
        and prev_meta.get("last_weekly_summary_date") != today_str
    )

    data = {
        "meta": {
            "trip_name": config["trip_name"],
            "origin": config["origin"],
            "origin_name": config.get("origin_name", config["origin"]),
            "destination": config["destination"],
            "destination_name": config.get("destination_name", config["destination"]),
            "adults": adults,
            "currency": config["currency"],
            "currency_symbol": config.get("currency_symbol", "₡"),
            "is_demo": False,
            "last_updated_iso": today_dt.isoformat(),
            "last_updated_display": today_dt.strftime("%d/%m/%Y %H:%M (CR)"),
            "total_scans": int(prev_meta.get("total_scans", 0)) + 1,
            "last_weekly_summary_date": prev_meta.get("last_weekly_summary_date"),
        },
        "windows": new_windows,
    }

    should_notify = force_notify or bool(all_alert_reasons) or is_weekly
    if should_notify:
        msg = build_telegram_message(config, data, all_alert_reasons, is_weekly, force_notify)
        if dry_run:
            print("\n--- VISTA PREVIA TELEGRAM (--dry-run) ---")
            print(msg)
            print("-----------------------------------------")
        else:
            token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
            chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
            if token and chat_id:
                sent = send_telegram_message(token, chat_id, msg)
                if sent and is_weekly:
                    data["meta"]["last_weekly_summary_date"] = today_str
            else:
                print(
                    "ℹ️ Notificación pendiente, pero faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID. "
                    "Se guardaron los datos sin enviar mensaje."
                )
    else:
        print("🔕 Sin bajadas fuertes hoy ni es día de resumen semanal; no se envió mensaje a Telegram.")

    save_outputs(data)
    print(f"💾 Datos guardados en {PRICES_JSON_PATH.relative_to(BASE_DIR)} y {DOCS_PRICES_JSON_PATH.relative_to(BASE_DIR)}")
    return 0


def main() -> int:
    load_dotenv(BASE_DIR / ".env")
    parser = argparse.ArgumentParser(
        description="Rastreador de vuelos SJO → MEX para Día de Muertos 2027."
    )
    parser.add_argument(
        "--demo",
        action="store_true",
        help="Genera datos realistas simulados para previsualizar el tablero sin gastar créditos de SerpApi.",
    )
    parser.add_argument(
        "--force-notify",
        action="store_true",
        help="Fuerza el envío del reporte actual a Telegram aunque no sea día de resumen ni haya bajada.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Muestra el mensaje de Telegram en consola sin enviarlo.",
    )
    parser.add_argument(
        "--test-dates",
        action="store_true",
        help="Prueba SerpApi en vivo con una fecha a ~90 días sin modificar el histórico 2027.",
    )
    parser.add_argument(
        "--get-chat-id",
        action="store_true",
        help="Detecta automáticamente tu TELEGRAM_CHAT_ID (personal o de grupo) a partir del último mensaje al bot.",
    )
    parser.add_argument(
        "--telegram-test",
        action="store_true",
        help="Envía un mensaje corto de prueba para confirmar que tu bot de Telegram funciona.",
    )

    args = parser.parse_args()
    config = load_config()

    if args.get_chat_id:
        return cmd_get_chat_id()

    if args.telegram_test:
        token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
        chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
        if not token or not chat_id:
            print("❌ Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en .env o variables de entorno.")
            return 1
        ok = send_telegram_message(
            token,
            chat_id,
            f"✅ <b>¡Bot conectado!</b>\nTu rastreador de vuelos para <b>{html.escape(config['trip_name'])}</b> ya puede enviarte alertas por aquí.",
        )
        return 0 if ok else 1

    if args.test_dates:
        return cmd_test_dates(config)

    if args.demo:
        demo_data = generate_demo_data(config)
        save_outputs(demo_data)
        print("✨ Datos de demostración generados en data/ y docs/data/.")
        if args.force_notify:
            msg = build_telegram_message(config, demo_data, [], is_weekly=False, is_forced=True)
            if args.dry_run:
                print("\n--- VISTA PREVIA TELEGRAM (DEMO) ---")
                print(msg)
                print("------------------------------------")
            else:
                token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
                chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
                if token and chat_id:
                    send_telegram_message(token, chat_id, msg)
                else:
                    print("ℹ️ Configura TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID para probar el envío real.")
        return 0

    return run_scan(config, force_notify=args.force_notify, dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
