# ✈️ Rastreador de Vuelos · SJO → CDMX (Día de Muertos 2027)

Aplicación 100% gratuita que monitorea diariamente precios de vuelos ida y vuelta desde **San José (`SJO`)** hacia **Ciudad de México (`MEX`)** para **2 adultos** en **colones costarricenses (`₡`)**, guarda el histórico diario, publica un **tablero web con gráficas en GitHub Pages** y envía **resumen semanal + alertas inmediatas por Telegram** cuando bajan los precios.

---

## Estructura del proyecto

* `config.json` — Configuración editable (aeropuertos, ventanas de fechas, reglas de alerta, enlace del tablero).
* `tracker.py` — Script en Python (sin librerías externas) que consulta SerpApi, actualiza el histórico y envía mensajes a Telegram.
* `data/` — Histórico en formato `prices.json` y `prices.csv` (para abrir en Excel / Google Sheets).
* `docs/` — Tablero web estático (`index.html`, `style.css`, `app.js`) listo para **GitHub Pages**.
* `.github/workflows/track-flights.yml` — Automatización diaria en la nube (corre todos los días a las 8:00 a. m. hora de Costa Rica).

---

## Comandos útiles (en tu Mac)

```bash
# 1. Generar datos de demostración y ver el tablero sin gastar créditos
python3 tracker.py --demo

# 2. Probar SerpApi hoy mismo con una fecha cercana (~90 días) sin tocar el histórico 2027
python3 tracker.py --test-dates

# 3. Detectar automáticamente tu Chat ID de Telegram (personal o de grupo)
python3 tracker.py --get-chat-id

# 4. Enviar mensaje de prueba a Telegram
python3 tracker.py --telegram-test

# 5. Ejecutar un escaneo real de las fechas 2027 (y ver vista previa de Telegram sin enviar)
python3 tracker.py --force-notify --dry-run
```

---

## Configuración paso a paso (100% gratis)

### Paso 1: Crear tu llave gratuita en SerpApi
1. Entra a [serpapi.com](https://serpapi.com) y crea una cuenta gratuita (no pide tarjeta; incluye **250 búsquedas/mes**).
2. En tu panel (*Dashboard*), copia tu **Private API Key** (`SERPAPI_KEY`).

### Paso 2: Crear tu bot de Telegram
1. En Telegram, busca a **`@BotFather`** y envíale `/newbot`.
2. Ponle un nombre (ej. `Vuelos CDMX`) y un usuario terminado en `bot` (ej. `vuelos_cdmx_2027_bot`).
3. `@BotFather` te dará un **Token** (`TELEGRAM_BOT_TOKEN`).
4. Si quieres que les llegue a ti y a tu novia: crea un grupo con los dos, agrega el bot al grupo y escribe un mensaje cualquiera (ej. `Hola`).
5. Para sacar el `TELEGRAM_CHAT_ID` automáticamente, coloca `TELEGRAM_BOT_TOKEN` en un archivo `.env` local (copiado de `.env.example`) y corre:
   ```bash
   python3 tracker.py --get-chat-id
   ```

### Paso 3: Subir a GitHub y activar automatización + tablero
1. Crea tu cuenta gratis en [github.com](https://github.com) y un repositorio **público** llamado `flight-tracker`.
2. Sube este proyecto a GitHub (te guiamos con los comandos `git` cuando estés listo).
3. En tu repositorio de GitHub ve a **Settings → Secrets and variables → Actions → New repository secret** y agrega los 3 secretos:
   * `SERPAPI_KEY`
   * `TELEGRAM_BOT_TOKEN`
   * `TELEGRAM_CHAT_ID`
4. Activa el tablero web en **Settings → Pages**:
   * **Source:** `Deploy from a branch`
   * **Branch:** `main` · Carpeta: `/docs` · **Save**.
5. En unos minutos tu tablero estará vivo en `https://TU_USUARIO.github.io/flight-tracker/`. Copia esa URL en `"dashboard_url"` dentro de `config.json` para que aparezca al pie de cada reporte en Telegram.

---

## Nota sobre créditos y ventana de aerolíneas
* `config.json` trae `"skip_if_return_beyond_days": 340` para **no gastar créditos** mientras falten más de ~11 meses para el regreso. En cuanto las fechas entren en ventana y las aerolíneas publiquen vuelos, recibirás una alerta inmediata por Telegram.
* Con 3 ventanas de fechas revisadas 1 vez al día se usan ~90 búsquedas al mes (menos de la mitad de las 250 gratuitas).
