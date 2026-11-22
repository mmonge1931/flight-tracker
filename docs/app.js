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

          bodyHtml = `
            <div class="win-price-row">
              <span class="win-price mono">${formatMoney(best.price, symbol)}</span>
              <span class="win-per">${formatMoney(best.price_per_person, symbol)}/persona</span>
              ${deltaHtml}
            </div>
            <div class="win-meta">
              <div>${escapeHtml(best.airline_summary)} · <strong>${formatStops(best.stops)}</strong> · ${formatDuration(best.total_duration_min)}</div>
              ${directLine}
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
                <div class="win-dates">${formatShortDate(w.outbound_date)} – ${formatShortDate(w.return_date)} 2027 · ${w.nights} noches</div>
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

    const subtitle =
      state.pricingMode === "per_person"
        ? `Precio estimado por persona (${state.flightType === "nonstop" ? "solo vuelos directos" : "mejor tarifa general"})`
        : `Precio total para ${adults} adultos (${state.flightType === "nonstop" ? "solo vuelos directos" : "mejor tarifa general"})`;
    document.getElementById("chart-subtitle").textContent = subtitle;

    if (state.chart) {
      state.chart.destroy();
    }

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

    descEl.textContent = `${selected.label} · ${formatShortDate(selected.outbound_date)} – ${formatShortDate(selected.return_date)} 2027`;

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

  async function init() {
    bindControls();
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
