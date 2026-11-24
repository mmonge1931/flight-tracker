(() => {
  const state = {
    data: null,
    selectedWindowId: null,
    pricingMode: "total", // "total" | "per_person"
    flightType: "overall", // "overall" | "nonstop"
    chart: null,
  };

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeExternalUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        return parsed.href;
      }
    } catch {
      return null;
    }
    return null;
  }

  function formatMoney(amount, symbol = "₡") {
    if (amount === null || amount === undefined || Number.isNaN(Number(amount))) {
      return "—";
    }
    return `${symbol}${Math.round(Number(amount)).toLocaleString("es-CR")}`;
  }

  function formatDuration(minutes) {
    if (!minutes || minutes <= 0) return "N/D";
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }

  function formatStops(stops) {
    if (stops === null || stops === undefined) return "N/D";
    if (stops === 0) return "Directo";
    if (stops === 1) return "1 escala";
    return `${stops} escalas`;
  }

  function formatShortDate(iso) {
    if (!iso) return "";
    const parts = iso.split("-");
    if (parts.length !== 3) return iso;
    const months = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
    const mIdx = parseInt(parts[1], 10) - 1;
    return `${parseInt(parts[2], 10)} ${months[mIdx] || parts[1]}`;
  }

  function formatDateRange(outIso, retIso) {
    if (!outIso || !retIso) return "";
    const outYear = outIso.split("-")[0];
    const retYear = retIso.split("-")[0];
    if (outYear && retYear && outYear !== retYear) {
      return `${formatShortDate(outIso)} ${outYear} – ${formatShortDate(retIso)} ${retYear}`;
    }
    return `${formatShortDate(outIso)} – ${formatShortDate(retIso)} ${retYear || ""}`.trim();
  }

  function levelBadge(level, status) {
    if (status !== "available") {
      return `<span class="badge badge-wait">Esperando vuelos</span>`;
    }
    if (level === "low") return `<span class="badge badge-low">Precio bajo</span>`;
    if (level === "high") return `<span class="badge badge-high">Precio alto</span>`;
    if (level === "typical") return `<span class="badge badge-typical">Precio típico</span>`;
    return `<span class="badge badge-wait">En seguimiento</span>`;
  }

  async function loadData() {
    if (window.location.protocol !== "file:") {
      try {
        const res = await fetch(`./data/prices.json?t=${Date.now()}`);
        if (res.ok) {
          return await res.json();
        }
      } catch (err) {
        console.warn("No se pudo cargar prices.json por HTTP; usando respaldo local.", err);
      }
    }
    if (window.FLIGHT_DATA) {
      return window.FLIGHT_DATA;
    }
    throw new Error("No se encontraron datos de vuelos. Corre: python3 tracker.py --demo");
  }

  function renderHeader(meta) {
    const symbol = meta.currency_symbol || "₡";
    document.getElementById("trip-title").textContent = meta.trip_name || "Rastreador de Vuelos";
    document.getElementById("route-pill").textContent =
      `${meta.origin} → ${meta.destination} · ${meta.adults || 2} adultos · ${meta.currency || "CRC"} (${symbol})`;
    document.getElementById("updated-pill").textContent =
      `Actualizado: ${meta.last_updated_display || "—"}`;
    document.getElementById("trip-subtitle").textContent =
      `Monitoreo automático de tarifas ida y vuelta desde ${meta.origin_name || meta.origin} hacia ${meta.destination_name || meta.destination}.`;

    const banner = document.getElementById("demo-banner");
    if (meta.is_demo) {
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  function renderKPIs(data) {
    const meta = data.meta || {};
    const symbol = meta.currency_symbol || "₡";
    const adults = meta.adults || 2;
    const windows = Object.values(data.windows || {});

    let bestToday = null;
    let bestDirect = null;
    let bestHistoric = null;

    for (const w of windows) {
      if (w.status === "available" && w.latest?.best_overall) {
        const p = w.latest.best_overall.price;
        if (!bestToday || p < bestToday.price) {
          bestToday = {
            price: p,
            perPerson: w.latest.best_overall.price_per_person ?? Math.round(p / adults),
            airline: w.latest.best_overall.airline_summary,
            label: w.label,
          };
        }
      }
      if (w.status === "available" && w.latest?.best_nonstop) {
        const p = w.latest.best_nonstop.price;
        if (!bestDirect || p < bestDirect.price) {
          bestDirect = {
            price: p,
            airline: w.latest.best_nonstop.airline_summary,
            duration: w.latest.best_nonstop.total_duration_min,
            label: w.label,
          };
        }
      }
      if (w.stats?.min_overall) {
        const p = w.stats.min_overall;
        if (!bestHistoric || p < bestHistoric.price) {
          bestHistoric = {
            price: p,
            date: w.stats.min_overall_date,
            label: w.label,
          };
        }
      }
    }

    document.getElementById("kpi-best-price").textContent = bestToday
      ? formatMoney(bestToday.price, symbol)
      : "Pendiente";
    document.getElementById("kpi-best-sub").textContent = bestToday
      ? `${formatMoney(bestToday.perPerson, symbol)}/persona · ${bestToday.label}`
      : "Aún no salen vuelos para estas fechas";

    document.getElementById("kpi-direct-price").textContent = bestDirect
      ? formatMoney(bestDirect.price, symbol)
      : "—";
    document.getElementById("kpi-direct-sub").textContent = bestDirect
      ? `${bestDirect.airline} · ${formatDuration(bestDirect.duration)} (${bestDirect.label})`
      : "Sin vuelos directos disponibles hoy";

    document.getElementById("kpi-min-price").textContent = bestHistoric
      ? formatMoney(bestHistoric.price, symbol)
      : "—";
    document.getElementById("kpi-min-sub").textContent = bestHistoric
      ? `Registrado el ${bestHistoric.date} · ${bestHistoric.label}`
      : "Se llenará con el historial diario";

    const diaMuertos = new Date("2027-11-01T00:00:00-06:00");
    const now = new Date();
    const daysLeft = Math.max(0, Math.ceil((diaMuertos - now) / (1000 * 60 * 60 * 24)));
    document.getElementById("kpi-countdown").textContent = `${daysLeft} días`;
  }

  function renderWindows(data) {
    const container = document.getElementById("windows-grid");
    const symbol = data.meta?.currency_symbol || "₡";
    const windows = Object.values(data.windows || {});

    container.innerHTML = windows
      .map((w) => {
        const isSelected = w.id === state.selectedWindowId;
        const best = w.latest?.best_overall;
        const nonstop = w.latest?.best_nonstop;
        const insights = w.latest?.price_insights || {};
        const stats = w.stats || {};
        const safeUrl = safeExternalUrl(w.latest?.google_flights_url);

        let bodyHtml = "";
        if (w.status === "available" && best) {
          let deltaHtml = "";
          if (stats.delta_crc !== null && stats.delta_crc !== undefined && stats.delta_crc !== 0) {
            const cls = stats.delta_crc < 0 ? "delta-down" : "delta-up";
            const sign = stats.delta_crc > 0 ? "+" : "";
            deltaHtml = `<span class="${cls}">${sign}${stats.delta_pct}% vs. ayer</span>`;
          }

          const directLine =
            nonstop && best.stops !== 0
              ? `<div>⚡ Directo: <strong>${formatMoney(nonstop.price, symbol)}</strong> (${escapeHtml(nonstop.airline_summary)})</div>`
              : "";

          const typicalLine =
            Array.isArray(insights.typical_price_range) && insights.typical_price_range.length === 2
              ? `<div>📊 Rango típico Google: ${formatMoney(insights.typical_price_range[0], symbol)} – ${formatMoney(insights.typical_price_range[1], symbol)}</div>`
              : "";

          bodyHtml = `
            <div class="win-price-row">
              <span class="win-price mono">${formatMoney(best.price, symbol)}</span>
              <span class="win-per">${formatMoney(best.price_per_person, symbol)}/persona</span>
              ${deltaHtml}
            </div>
            <div class="win-meta">
              <div>${escapeHtml(best.airline_summary)} · <strong>${formatStops(best.stops)}</strong> · ${formatDuration(best.total_duration_min)}</div>
              ${directLine}
              ${typicalLine}
            </div>
          `;
        } else {
          bodyHtml = `
            <div class="win-meta">
              <span class="muted">${escapeHtml(w.status_message || "Esperando publicación de tarifas.")}</span>
            </div>
          `;
        }

        const minLabel = stats.min_overall
          ? `<span class="min-tag">Mínimo: ${formatMoney(stats.min_overall, symbol)}</span>`
          : `<span class="min-tag">Sin histórico aún</span>`;

        const linkHtml = safeUrl
          ? `<a class="gf-link" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">Google Flights ↗</a>`
          : "";

        return `
          <article class="window-card ${isSelected ? "selected" : ""}" style="--accent:${escapeHtml(w.color || "#f59e0b")}" data-window-id="${escapeHtml(w.id)}">
            <div class="win-head">
              <div>
                <div class="win-title-wrap">
                  <span class="color-dot" style="background:${escapeHtml(w.color || "#f59e0b")}"></span>
                  <span class="win-title">${escapeHtml(w.label)}</span>
                </div>
                <div class="win-dates">${formatDateRange(w.outbound_date, w.return_date)} · ${w.nights} noches</div>
              </div>
              ${levelBadge(insights.price_level, w.status)}
            </div>
            ${bodyHtml}
            <div class="win-actions">
              ${minLabel}
              ${linkHtml}
            </div>
            <div class="win-note">${escapeHtml(w.note || "")}</div>
          </article>
        `;
      })
      .join("");

    container.querySelectorAll(".window-card").forEach((el) => {
      el.addEventListener("click", () => {
        state.selectedWindowId = el.getAttribute("data-window-id");
        renderWindows(state.data);
        renderFlightsTable(state.data);
      });
    });
  }

  function renderChart(data) {
    const symbol = data.meta?.currency_symbol || "₡";
    const adults = data.meta?.adults || 2;
    const windows = Object.values(data.windows || {});

    const allDatesSet = new Set();
    windows.forEach((w) => {
      (w.history || []).forEach((h) => {
        if (h.status === "available") allDatesSet.add(h.date);
      });
    });
    const labels = Array.from(allDatesSet).sort();

    const emptyEl = document.getElementById("chart-empty");
    const canvas = document.getElementById("priceChart");

    if (!labels.length || typeof Chart === "undefined") {
      emptyEl.classList.remove("hidden");
      canvas.classList.add("hidden");
      if (state.chart) {
        state.chart.destroy();
        state.chart = null;
      }
      return;
    }

    emptyEl.classList.add("hidden");
    canvas.classList.remove("hidden");

    const modeDesc =
      state.pricingMode === "per_person"
        ? `Precio estimado por persona (${state.flightType === "nonstop" ? "solo vuelos directos" : "mejor tarifa general"})`
        : `Precio total para ${adults} adultos (${state.flightType === "nonstop" ? "solo vuelos directos" : "mejor tarifa general"})`;

    if (state.chart) {
      state.chart.destroy();
    }

    // Día 1 de datos reales: mostrar gráfica de barras comparativa entre ventanas
    if (labels.length === 1) {
      const onlyDate = labels[0];
      document.getElementById("chart-subtitle").textContent =
        `Comparativa real de hoy (${formatShortDate(onlyDate)}) · ${modeDesc} · A partir de mañana verás la curva histórica día a día`;

      const barLabels = windows.map((w) => w.label);
      const barValues = windows.map((w) => {
        const entry = (w.history || []).find((h) => h.date === onlyDate && h.status === "available");
        if (!entry) return null;
        const rawPrice =
          state.flightType === "nonstop" ? entry.best_nonstop_price : entry.best_overall_price;
        if (!rawPrice) return null;
        return state.pricingMode === "per_person" ? Math.round(rawPrice / adults) : rawPrice;
      });
      const barColors = windows.map((w) => w.color || "#f59e0b");
      const validBarVals = barValues.filter((v) => v !== null && v !== undefined);
      const minBar = validBarVals.length ? Math.min(...validBarVals) : 0;
      const maxBar = validBarVals.length ? Math.max(...validBarVals) : 0;
      const suggestedMin = minBar > 0 ? Math.floor((minBar * 0.82) / 10000) * 10000 : 0;
      const suggestedMax = maxBar > 0 ? Math.ceil((maxBar * 1.06) / 10000) * 10000 : undefined;

      state.chart = new Chart(canvas, {
        type: "bar",
        data: {
          labels: barLabels,
          datasets: [
            {
              label: state.flightType === "nonstop" ? "Mejor vuelo directo hoy" : "Mejor tarifa hoy",
              data: barValues,
              backgroundColor: barColors.map((c) => `${c}cc`),
              borderColor: barColors,
              borderWidth: 2,
              borderRadius: 10,
              maxBarThickness: 72,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: "#111827",
              titleColor: "#f9fafb",
              bodyColor: "#e5e7eb",
              borderColor: "rgba(255,255,255,0.12)",
              borderWidth: 1,
              padding: 12,
              callbacks: {
                label: (ctx) => `${ctx.dataset.label}: ${formatMoney(ctx.parsed.y, symbol)}`,
              },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: "#d1d5db", font: { family: "Plus Jakarta Sans", size: 12 } },
            },
            y: {
              beginAtZero: false,
              suggestedMin,
              suggestedMax,
              grid: { color: "rgba(255,255,255,0.06)" },
              ticks: {
                color: "#9ca3af",
                callback: (v) => formatMoney(v, symbol),
              },
            },
          },
        },
      });
      return;
    }

    const datasets = windows.map((w) => {
      const byDate = new Map((w.history || []).map((h) => [h.date, h]));
      const values = labels.map((d) => {
        const entry = byDate.get(d);
        if (!entry || entry.status !== "available") return null;
        const rawPrice =
          state.flightType === "nonstop" ? entry.best_nonstop_price : entry.best_overall_price;
        if (!rawPrice) return null;
        return state.pricingMode === "per_person" ? Math.round(rawPrice / adults) : rawPrice;
      });

      const color = w.color || "#f59e0b";
      return {
        label: w.label,
        data: values,
        borderColor: color,
        backgroundColor: `${color}22`,
        borderWidth: 2.5,
        pointRadius: labels.length <= 20 ? 3.5 : 2,
        pointHoverRadius: 6,
        tension: 0.28,
        spanGaps: true,
      };
    });

    document.getElementById("chart-subtitle").textContent = modeDesc;

    state.chart = new Chart(canvas, {
      type: "line",
      data: {
        labels: labels.map(formatShortDate),
        datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            position: "bottom",
            labels: {
              color: "#d1d5db",
              usePointStyle: true,
              padding: 18,
              font: { family: "Plus Jakarta Sans", size: 12 },
            },
          },
          tooltip: {
            backgroundColor: "#111827",
            titleColor: "#f9fafb",
            bodyColor: "#e5e7eb",
            borderColor: "rgba(255,255,255,0.12)",
            borderWidth: 1,
            padding: 12,
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${formatMoney(ctx.parsed.y, symbol)}`,
            },
          },
        },
        scales: {
          x: {
            grid: { color: "rgba(255,255,255,0.05)" },
            ticks: { color: "#9ca3af", maxRotation: 0, autoSkipPadding: 14 },
          },
          y: {
            grid: { color: "rgba(255,255,255,0.06)" },
            ticks: {
              color: "#9ca3af",
              callback: (v) => formatMoney(v, symbol),
            },
          },
        },
      },
    });
  }

  function renderFlightsTable(data) {
    const windows = Object.values(data.windows || {});
    const tabsEl = document.getElementById("window-tabs");
    const tbody = document.getElementById("flights-tbody");
    const descEl = document.getElementById("selected-window-desc");
    const symbol = data.meta?.currency_symbol || "₡";

    tabsEl.innerHTML = windows
      .map(
        (w) => `
        <button type="button" class="tab-btn ${w.id === state.selectedWindowId ? "active" : ""}" data-tab-id="${escapeHtml(w.id)}">
          ${escapeHtml(w.label)}
        </button>`
      )
      .join("");

    tabsEl.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.selectedWindowId = btn.getAttribute("data-tab-id");
        renderWindows(state.data);
        renderFlightsTable(state.data);
      });
    });

    const selected = (data.windows || {})[state.selectedWindowId] || windows[0];
    if (!selected) return;

    descEl.textContent = `${selected.label} · ${formatDateRange(selected.outbound_date, selected.return_date)}`;

    const flights = selected.latest?.top_flights || [];
    if (selected.status !== "available" || !flights.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="empty-cell">
            ${escapeHtml(selected.status_message || "Todavía no hay vuelos disponibles para esta ventana de fechas.")}
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = flights
      .map((f) => {
        const stopClass = f.stops === 0 ? "stop-direct" : "stop-layover";
        const layoverTxt = f.layovers?.length ? ` (${escapeHtml(f.layovers.join(", "))})` : "";
        const depTime = f.departure_time ? escapeHtml(f.departure_time.split(" ").slice(-1)[0]) : "—";
        return `
          <tr>
            <td><strong>${escapeHtml(f.airline_summary)}</strong></td>
            <td><span class="stop-pill ${stopClass}">${formatStops(f.stops)}</span>${layoverTxt}</td>
            <td>${formatDuration(f.total_duration_min)}</td>
            <td class="mono">${depTime}</td>
            <td class="num mono">${formatMoney(f.price_per_person, symbol)}</td>
            <td class="num mono"><strong>${formatMoney(f.price, symbol)}</strong></td>
          </tr>`;
      })
      .join("");
  }

  function bindControls() {
    document.querySelectorAll("[data-pricing]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.pricingMode = btn.getAttribute("data-pricing");
        document.querySelectorAll("[data-pricing]").forEach((b) => b.classList.toggle("active", b === btn));
        renderChart(state.data);
      });
    });

    document.querySelectorAll("[data-flight-type]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.flightType = btn.getAttribute("data-flight-type");
        document.querySelectorAll("[data-flight-type]").forEach((b) => b.classList.toggle("active", b === btn));
        renderChart(state.data);
      });
    });
  }

  /* Selector de fechas sin código (conecta con GitHub Actions update-dates.yml) */
  const GH_OWNER = "mmonge1931";
  const GH_REPO = "flight-tracker";
  const GH_WORKFLOW = "update-dates.yml";
  const TOKEN_STORAGE_KEY = "flight_tracker_gh_pat";

  function toIsoDate(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function addUtcDays(d, days) {
    const copy = new Date(d.getTime());
    copy.setUTCDate(copy.getUTCDate() + days);
    return copy;
  }

  function calcNightsIso(outStr, retStr) {
    if (!outStr || !retStr) return null;
    const o = new Date(`${outStr}T00:00:00Z`);
    const r = new Date(`${retStr}T00:00:00Z`);
    if (Number.isNaN(o.getTime()) || Number.isNaN(r.getTime())) return null;
    return Math.round((r - o) / (1000 * 60 * 60 * 24));
  }

  function bindDateModal() {
    const modal = document.getElementById("dates-modal");
    const openBtn = document.getElementById("open-dates-btn");
    const closeBtn = document.getElementById("close-dates-btn");
    const form = document.getElementById("dates-form");
    if (!modal || !openBtn || !form) return;

    const tripInput = document.getElementById("input-trip-name");
    const notifyInput = document.getElementById("input-notify-tg");
    const tokenDetails = document.getElementById("token-details");
    const tokenStatus = document.getElementById("token-status");
    const tokenInput = document.getElementById("input-gh-token");
    const saveTokenBtn = document.getElementById("save-token-btn");
    const clearTokenBtn = document.getElementById("clear-token-btn");
    const feedbackEl = document.getElementById("dates-feedback");
    const submitBtn = document.getElementById("submit-dates-btn");

    const pairs = [
      { out: document.getElementById("opt1-out"), ret: document.getElementById("opt1-ret"), badge: document.getElementById("nights-1") },
      { out: document.getElementById("opt2-out"), ret: document.getElementById("opt2-ret"), badge: document.getElementById("nights-2") },
      { out: document.getElementById("opt3-out"), ret: document.getElementById("opt3-ret"), badge: document.getElementById("nights-3") },
    ];

    let activePreset = "personalizado";

    function showFeedback(htmlMsg, isOk) {
      feedbackEl.innerHTML = htmlMsg;
      feedbackEl.classList.remove("hidden", "ok", "err");
      feedbackEl.classList.add(isOk ? "ok" : "err");
    }

    function hideFeedback() {
      feedbackEl.classList.add("hidden");
      feedbackEl.innerHTML = "";
    }

    function refreshTokenUi() {
      const saved = (localStorage.getItem(TOKEN_STORAGE_KEY) || "").trim();
      if (saved) {
        tokenStatus.textContent = "Conectado";
        tokenStatus.classList.add("connected");
        clearTokenBtn.classList.remove("hidden");
        tokenInput.placeholder = "Token guardado en este dispositivo";
      } else {
        tokenStatus.textContent = "No conectado";
        tokenStatus.classList.remove("connected");
        clearTokenBtn.classList.add("hidden");
        tokenInput.placeholder = "ghp_...";
      }
    }

    function refreshNights() {
      pairs.forEach(({ out, ret, badge }) => {
        badge.classList.remove("invalid");
        if (!out.value && !ret.value) {
          badge.textContent = "Sin usar";
          return;
        }
        if (!out.value || !ret.value) {
          badge.textContent = "Incompleta";
          badge.classList.add("invalid");
          return;
        }
        const n = calcNightsIso(out.value, ret.value);
        if (n === null || n <= 0) {
          badge.textContent = "Regreso debe ser posterior";
          badge.classList.add("invalid");
        } else {
          badge.textContent = `${n} noches`;
        }
      });
    }

    function prefillFromCurrent() {
      const windows = Object.values(state.data?.windows || {});
      tripInput.value = state.data?.meta?.trip_name || "";
      pairs.forEach((p, idx) => {
        const w = windows[idx];
        p.out.value = w?.outbound_date || "";
        p.ret.value = w?.return_date || "";
      });
      activePreset = "personalizado";
      refreshNights();
      refreshTokenUi();
      hideFeedback();
    }

    function openModal() {
      prefillFromCurrent();
      modal.classList.remove("hidden");
    }

    function closeModal() {
      modal.classList.add("hidden");
    }

    openBtn.addEventListener("click", openModal);
    closeBtn.addEventListener("click", closeModal);
    modal.addEventListener("click", (ev) => {
      if (ev.target === modal) closeModal();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
    });

    pairs.forEach(({ out, ret }) => {
      const onManualChange = () => {
        activePreset = "personalizado";
        refreshNights();
      };
      out.addEventListener("input", onManualChange);
      ret.addEventListener("input", onManualChange);
    });

    document.getElementById("preset-farthest")?.addEventListener("click", () => {
      const nowCr = new Date(Date.now() - 6 * 60 * 60 * 1000);
      const todayUtc = new Date(Date.UTC(nowCr.getUTCFullYear(), nowCr.getUTCMonth(), nowCr.getUTCDate()));
      const maxRet = addUtcDays(todayUtc, 329);
      const offsets = [4, 2, 0];
      offsets.forEach((back, idx) => {
        const r = addUtcDays(maxRet, -back);
        const o = addUtcDays(r, -8);
        pairs[idx].out.value = toIsoDate(o);
        pairs[idx].ret.value = toIsoDate(r);
      });
      const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
      tripInput.value = `CDMX · Fechas más lejanas (${months[maxRet.getUTCMonth()]} ${maxRet.getUTCFullYear()})`;
      activePreset = "mas-lejanas";
      refreshNights();
      hideFeedback();
    });

    document.getElementById("preset-muertos")?.addEventListener("click", () => {
      const presetDates = [
        ["2027-10-27", "2027-11-04"],
        ["2027-10-29", "2027-11-06"],
        ["2027-10-31", "2027-11-08"],
      ];
      presetDates.forEach(([o, r], idx) => {
        pairs[idx].out.value = o;
        pairs[idx].ret.value = r;
      });
      tripInput.value = "CDMX · Día de Muertos 2027";
      activePreset = "dia-de-muertos-2027";
      refreshNights();
      hideFeedback();
    });

    saveTokenBtn.addEventListener("click", () => {
      const val = tokenInput.value.trim();
      if (!val) {
        showFeedback("Pega tu token de GitHub (<code>ghp_...</code>) antes de guardar.", false);
        return;
      }
      localStorage.setItem(TOKEN_STORAGE_KEY, val);
      tokenInput.value = "";
      refreshTokenUi();
      showFeedback("✅ Token guardado solo en este navegador. Ya puedes aplicar cambios en 1 clic.", true);
    });

    clearTokenBtn.addEventListener("click", () => {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      tokenInput.value = "";
      refreshTokenUi();
      showFeedback("Token eliminado de este navegador.", true);
    });

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      hideFeedback();

      let validCount = 0;
      for (let i = 0; i < pairs.length; i++) {
        const o = pairs[i].out.value.trim();
        const r = pairs[i].ret.value.trim();
        if (!o && !r) continue;
        if (!o || !r) {
          showFeedback(`La Opción ${i + 1} está incompleta: indica fecha de ida y regreso.`, false);
          return;
        }
        const n = calcNightsIso(o, r);
        if (n === null || n <= 0) {
          showFeedback(`En la Opción ${i + 1}, la fecha de regreso debe ser posterior a la de ida.`, false);
          return;
        }
        validCount++;
      }

      if (validCount === 0) {
        showFeedback("Debes elegir al menos una opción de fechas.", false);
        return;
      }

      let token = (localStorage.getItem(TOKEN_STORAGE_KEY) || "").trim();
      if (!token && tokenInput.value.trim()) {
        token = tokenInput.value.trim();
        localStorage.setItem(TOKEN_STORAGE_KEY, token);
        tokenInput.value = "";
        refreshTokenUi();
      }

      if (!token) {
        tokenDetails.open = true;
        tokenInput.focus();
        showFeedback(
          'Para aplicar en 1 clic desde aquí, pega una sola vez tu token de GitHub arriba (se guarda solo en este dispositivo). Si prefieres no guardarlo aquí, usa el botón <strong>"Abrir en GitHub ↗"</strong>.',
          false
        );
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "Enviando a GitHub...";

      try {
        const res = await fetch(
          `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`,
          {
            method: "POST",
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify({
              ref: "main",
              inputs: {
                preset: activePreset,
                trip_name: tripInput.value.trim(),
                opt1_out: pairs[0].out.value.trim(),
                opt1_ret: pairs[0].ret.value.trim(),
                opt2_out: pairs[1].out.value.trim(),
                opt2_ret: pairs[1].ret.value.trim(),
                opt3_out: pairs[2].out.value.trim(),
                opt3_ret: pairs[2].ret.value.trim(),
                notify_telegram: notifyInput.checked ? "true" : "false",
              },
            }),
          }
        );

        if (res.status === 204) {
          showFeedback(
            `✅ <strong>¡Listo! Cambio enviado a GitHub.</strong> En ~1–2 minutos el tablero se actualizará solo con las nuevas fechas y recibirás el reporte en Telegram. ` +
              `<a href="https://github.com/${GH_OWNER}/${GH_REPO}/actions" target="_blank" rel="noopener noreferrer">Ver progreso en GitHub ↗</a>`,
            true
          );
        } else if (res.status === 401 || res.status === 403) {
          tokenDetails.open = true;
          showFeedback(
            "GitHub rechazó el token (401/403). Asegúrate de que tenga los permisos <code>repo</code> y <code>workflow</code> y no haya expirado.",
            false
          );
        } else {
          const detail = await res.text().catch(() => "");
          showFeedback(`Error al enviar a GitHub (HTTP ${res.status}). ${escapeHtml(detail.slice(0, 140))}`, false);
        }
      } catch (err) {
        showFeedback(`No se pudo conectar con GitHub: ${escapeHtml(err.message)}`, false);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Aplicar fechas y escanear";
      }
    });
  }

  async function init() {
    bindControls();
    bindDateModal();
    try {
      const data = await loadData();
      state.data = data;
      const firstWindow = Object.values(data.windows || {})[0];
      state.selectedWindowId = firstWindow ? firstWindow.id : null;
      renderHeader(data.meta || {});
      renderKPIs(data);
      renderWindows(data);
      renderChart(data);
      renderFlightsTable(data);
    } catch (err) {
      document.getElementById("updated-pill").textContent = "Sin datos";
      document.getElementById("flights-tbody").innerHTML = `
        <tr><td colspan="6" class="empty-cell">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  init();
})();
