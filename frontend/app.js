/* ==========================================================================
   Backtester frontend
   --------------------------------------------------------------------------
   This file only DISPLAYS data from data.json. It contains no strategy
   logic, no signal generation, no P&L computation — all of that is expected
   to be produced by the Python backtest that writes data.json.
   ========================================================================== */

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  const state = {
    data: null,
    chart: null,
    candleSeries: null,
    volumeSeries: null,
    overlaySeries: [],       // dynamically created SL/target line series
    selectedTradeId: null,
    directionFilter: "ALL",
    dateFilter: "ALL",
    rrFilter: "1:2",
    exitReasonFilter: "ALL",
    searchTerm: "",
    barIntervalSec: 900,     // inferred from candle spacing, default 15m
  };

  const COLOR = {
    teal: "#2fd6a7",
    tealDim: "rgba(47, 214, 167, 0.32)",
    red: "#f0546a",
    redDim: "rgba(240, 84, 106, 0.32)",
    amber: "#e0a33d",
  };

  // ---------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindStaticControls();

    let data;
    try {
      const res = await fetch("data.json");
      data = await res.json();
    } catch (err) {
      renderFatalError(err);
      return;
    }

    state.data = normalizeData(data);
    state.barIntervalSec = inferBarInterval(state.data.candles);

    renderHeader(state.data.backtest, state.data.candles);
    populateDateFilter();
    state.rrFilter = state.data.defaultRr || "1:2";
    document.getElementById("rrFilter").value = state.rrFilter;
    renderCards(calculateMetrics(filteredDashboardTrades()));
    initChart(state.data.candles);
    refreshDashboard();
  }

  function renderFatalError(err) {
    const el = document.getElementById("chartLoading");
    el.textContent = "Could not load data.json — " + (err && err.message ? err.message : "unknown error");
  }

  // Fill in a couple of defensive defaults so a partially-populated
  // data.json from a new Python strategy doesn't break the UI.
  function toUnixSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1000000000000
      ? Math.floor(value / 1000)
      : Math.floor(value);
  }

  const text = String(value).trim();
const ms = Date.parse(text.endsWith("Z") ? text : `${text}Z`);
return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

  function normalizeTrade(t) {
    return {
      ...t,
      id: t.id ?? t.tradeId,
      date: toUnixSeconds(t.date),
      signalTime: toUnixSeconds(t.signalTime),
      entryTime: toUnixSeconds(t.entryTime),
      exitTime: toUnixSeconds(t.exitTime),
      events: Array.isArray(t.events)
        ? t.events.map((e) => ({ ...e, time: toUnixSeconds(e.time) }))
        : []
    };
  }

  function normalizeData(raw) {
  raw.backtest = raw.backtest || {};
  raw.candles = Array.isArray(raw.candles) ? raw.candles : [];
  raw.trades = Array.isArray(raw.trades) ? raw.trades : [];
  raw.metrics = raw.metrics || {};

  raw.candles = raw.candles
    .map((c) => ({
      ...c,
      time: toUnixSeconds(c.time)
    }))
    .filter((c) =>
      c.time !== null &&
      isNum(c.open) &&
      isNum(c.high) &&
      isNum(c.low) &&
      isNum(c.close)
    );

  raw.trades = raw.trades.map(normalizeTrade);

  raw.rrScenarios = raw.rrScenarios || {
    "1:2": { trades: raw.trades, metrics: raw.metrics, equityCurve: raw.equityCurve || [] }
  };
  Object.values(raw.rrScenarios).forEach((scenario) => {
    scenario.trades = Array.isArray(scenario.trades) ? scenario.trades.map(normalizeTrade) : [];
    scenario.metrics = scenario.metrics || {};
  });
  raw.defaultRr = raw.defaultRr || "1:2";

  if (raw.metrics.wins === undefined) {
    raw.metrics.wins = raw.metrics.winningTrades;
  }

  if (raw.metrics.losses === undefined) {
    raw.metrics.losses = raw.metrics.losingTrades;
  }

  raw.trades.forEach((t) => {
    if (t.stopLoss === undefined) t.stopLoss = null;
    if (t.target === undefined) t.target = null;
  });

  raw.backtest.startDate = toUnixSeconds(raw.backtest.startDate);
  raw.backtest.endDate = toUnixSeconds(raw.backtest.endDate);

  return raw;
}

  function inferBarInterval(candles) {
    if (candles.length < 2) return 900;
    const diffs = [];
    for (let i = 1; i < Math.min(candles.length, 30); i++) {
      const d = candles[i].time - candles[i - 1].time;
      if (d > 0) diffs.push(d);
    }
    if (!diffs.length) return 900;
    diffs.sort((a, b) => a - b);
    return diffs[Math.floor(diffs.length / 2)];
  }

  // ---------------------------------------------------------------------
  // Header
  // ---------------------------------------------------------------------
  function renderHeader(backtest, candles) {
    document.getElementById("metaSymbol").textContent = backtest.symbol || "—";
    document.getElementById("metaStrategy").textContent = backtest.strategy || "—";
    document.getElementById("metaTimeframe").textContent = backtest.timeframe || "—";
let from = backtest.startDate;
let to = backtest.endDate;
    if (!from && candles.length) from = candles[0].time;
    if (!to && candles.length) to = candles[candles.length - 1].time;

    document.getElementById("metaDateRange").textContent =
      from && to ? `${formatDate(from)} – ${formatDate(to)}` : "—";

    document.title = `Backtester · ${backtest.symbol || "Strategy"}`;
  }

  // ---------------------------------------------------------------------
  // Performance cards
  // ---------------------------------------------------------------------
  function renderCards(m) {
    setText("cardTotalTrades", isNum(m.totalTrades) ? m.totalTrades : "—");

    const winRateEl = document.getElementById("cardWinRate");
    winRateEl.textContent = isNum(m.winRate) ? `${round1(m.winRate)}%` : "—";
    document.getElementById("cardWinRateBar").style.width = isNum(m.winRate) ? `${clamp(m.winRate, 0, 100)}%` : "0%";

    const netEl = document.getElementById("cardNetPnl");
    netEl.textContent = isNum(m.netPnl) ? formatSigned(m.netPnl) : "—";
    netEl.classList.toggle("positive", isNum(m.netPnl) && m.netPnl > 0);
    netEl.classList.toggle("negative", isNum(m.netPnl) && m.netPnl < 0);

    setText("cardProfitFactor", isNum(m.profitFactor) ? round2(m.profitFactor) : "—");
    setText("cardMaxDrawdown", isNum(m.maxDrawdown) ? formatNumber(m.maxDrawdown) : "—");
    setText("cardWins", isNum(m.wins) ? m.wins : "—");
    setText("cardLosses", isNum(m.losses) ? m.losses : "—");
    setText("cardGrossProfit", isNum(m.grossProfit) ? formatSigned(m.grossProfit) : "—");
    setText("cardGrossLoss", isNum(m.grossLoss) ? formatNumber(m.grossLoss) : "—");
    setText("cardAverageTrade", isNum(m.averageTrade) ? formatSigned(m.averageTrade) : "—");
    setText("cardLargestWin", isNum(m.largestWin) ? formatSigned(m.largestWin) : "—");
    setText("cardLargestLoss", isNum(m.largestLoss) ? formatSigned(m.largestLoss) : "—");
  }

  // ---------------------------------------------------------------------
  // Chart
  // ---------------------------------------------------------------------
  function initChart(candles) {
    const container = document.getElementById("chartContainer");

    state.chart = LightweightCharts.createChart(container, {
      layout: {
        background: { type: "solid", color: "transparent" },
        textColor: "#a7b1c2",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.035)" },
        horzLines: { color: "rgba(255,255,255,0.035)" },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: "#3a4456", labelBackgroundColor: "#1a212c" },
        horzLine: { color: "#3a4456", labelBackgroundColor: "#1a212c" },
      },
      rightPriceScale: {
        borderColor: "#232b38",
        scaleMargins: { top: 0.08, bottom: 0.2 },
      },
      timeScale: {
        borderColor: "#232b38",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
      },
      autoSize: true,
    });

    state.candleSeries = state.chart.addCandlestickSeries({
      upColor: COLOR.teal,
      downColor: COLOR.red,
      borderUpColor: COLOR.teal,
      borderDownColor: COLOR.red,
      wickUpColor: "rgba(47, 214, 167, 0.6)",
      wickDownColor: "rgba(240, 84, 106, 0.6)",
    });

    state.candleSeries.setData(
      candles.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );

    // Volume as a thin histogram pinned to the bottom of the price pane.
    if (candles.some((c) => isNum(c.volume))) {
      state.volumeSeries = state.chart.addHistogramSeries({
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
        color: "rgba(120,140,170,0.35)",
      });
      state.volumeSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
      });
      state.volumeSeries.setData(
        candles.map((c) => ({
          time: c.time,
          value: c.volume || 0,
          color: c.close >= c.open ? "rgba(47, 214, 167, 0.35)" : "rgba(240, 84, 106, 0.35)",
        }))
      );
    }

    state.chart.timeScale().fitContent();
    document.getElementById("chartLoading").classList.add("hidden");

    document.getElementById("btnResetView").addEventListener("click", () => {
      deselectTrade();
    });
  }

  // ---------------------------------------------------------------------
  // Trade overlays (markers + SL/target lines) on the chart
  // ---------------------------------------------------------------------
  function dateKey(unixSeconds) {
    return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
  }

  function activeScenario() {
    if (state.rrFilter === "ALL") {
      return {
        trades: Object.entries(state.data.rrScenarios).flatMap(([rr, scenario]) =>
          scenario.trades.map((trade) => ({ ...trade, id: `${rr}-${trade.id}` }))
        )
      };
    }
    return state.data.rrScenarios[state.rrFilter] || state.data.rrScenarios[state.data.defaultRr];
  }

  function filteredCandles() {
    if (state.dateFilter === "ALL") return state.data.candles;
    return state.data.candles.filter((c) => dateKey(c.time) === state.dateFilter);
  }

  function filteredDashboardTrades() {
    return activeScenario().trades.filter((t) => {
      if (state.directionFilter !== "ALL" && t.direction !== state.directionFilter) return false;
      if (state.dateFilter !== "ALL" && dateKey(t.date) !== state.dateFilter) return false;
      return state.exitReasonFilter === "ALL" || normalizeExitReason(t.exitReason) === state.exitReasonFilter;
    });
  }

  function normalizeExitReason(reason) {
    return String(reason || "").trim().toUpperCase().replace(/_/g, " ");
  }

  function currentFilteredTrades() {
    const term = state.searchTerm.trim().toLowerCase();
    return filteredDashboardTrades().filter((t) => {
      if (!term) return true;
      const haystack = `${t.id} ${t.direction} ${t.exitReason || ""}`.toLowerCase();
      return haystack.includes(term);
    });
  }

  function refreshOverlays() {
    clearOverlaySeries();

    const trades = filteredDashboardTrades();
    const markers = [];

    trades.forEach((t) => {
      const isSelected = t.id === state.selectedTradeId;
      const dim = state.selectedTradeId !== null && !isSelected;

      addTradeMarkers(markers, t, dim);
      addTradeLevelLines(t, dim, isSelected);
    });

    markers.sort((a, b) => a.time - b.time);
    state.candleSeries.setMarkers(markers);
  }

  function refreshDashboard() {
    const dashboardTrades = filteredDashboardTrades();
    const candles = filteredCandles();

    if (!dashboardTrades.some((t) => t.id === state.selectedTradeId)) {
      state.selectedTradeId = null;
      renderDetailPanel(null);
    }

    state.candleSeries.setData(candles.map((c) => ({
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
    })));
    if (state.volumeSeries) {
      state.volumeSeries.setData(candles.map((c) => ({
        time: c.time,
        value: c.volume || 0,
        color: c.close >= c.open ? "rgba(47, 214, 167, 0.35)" : "rgba(240, 84, 106, 0.35)",
      })));
    }
    renderCards(calculateMetrics(dashboardTrades));
    setText("metricsContext", filterContextLabel());
    renderStrategyAnalysis();
    refreshOverlays();
    refreshTable();
    state.chart.timeScale().fitContent();
    document.getElementById("chartSubtitle").textContent = chartFilterLabel(dashboardTrades.length);
  }

  function calculateMetrics(trades) {
    const pnls = trades.map((t) => t.pnl).filter(isNum);
    const wins = pnls.filter((pnl) => pnl > 0);
    const losses = pnls.filter((pnl) => pnl < 0);
    const grossProfit = wins.reduce((sum, pnl) => sum + pnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, pnl) => sum + pnl, 0));
    let runningPnl = 0;
    let peakPnl = 0;
    let maxDrawdown = 0;
    pnls.forEach((pnl) => {
      runningPnl += pnl;
      peakPnl = Math.max(peakPnl, runningPnl);
      maxDrawdown = Math.max(maxDrawdown, peakPnl - runningPnl);
    });
    return {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      netPnl: pnls.reduce((sum, pnl) => sum + pnl, 0),
      profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : 0,
      maxDrawdown,
      grossProfit,
      grossLoss,
      averageTrade: pnls.length ? pnls.reduce((sum, pnl) => sum + pnl, 0) / pnls.length : 0,
      largestWin: pnls.length ? Math.max(...pnls) : 0,
      largestLoss: pnls.length ? Math.min(...pnls) : 0,
    };
  }

  function filterContextLabel() {
    const date = state.dateFilter === "ALL" ? "ALL DATES" : formatDate(toUnixSeconds(state.dateFilter));
    const exitReason = state.exitReasonFilter === "ALL" ? "ALL EXIT REASONS" : state.exitReasonFilter;
    return `R:R ${state.rrFilter} — ${state.directionFilter} — ${date} — ${exitReason}`;
  }

  function activeAnalysisScope() {
    const rr = state.rrFilter === "ALL" ? state.data.defaultRr : state.rrFilter;
    return state.data.strategyAnalysis?.scopes?.[rr]?.[state.dateFilter] || null;
  }

  function renderStrategyAnalysis() {
    const analysis = state.data.strategyAnalysis;
    const scope = activeAnalysisScope();
    const rrLabel = state.rrFilter === "ALL" ? "ALL R:R (1:2 analysis)" : state.rrFilter;
    const dateLabel = state.dateFilter === "ALL" ? "ALL DATES" : formatDate(toUnixSeconds(state.dateFilter));
    setText("analysisScope", `R:R ${rrLabel} — ${state.directionFilter} — ${dateLabel}`);

    if (!analysis || !scope) return;

    const best = analysis.bestRr;
    setText("analysisBestOverall", bestRrLabel(best.all));
    setText("analysisBestLong", bestRrLabel(best.long));
    setText("analysisBestShort", bestRrLabel(best.short));

    const selectedSummary = scope.directions[state.directionFilter].summary;
    const edge = scope.directionEdge;
    const edgeLabel = edge.strongerDirection === "EVEN" ? "LONG / SHORT evenly matched" : `${edge.strongerDirection} stronger edge`;
    setText("analysisDirectionEdge", edgeLabel);
    setText(
      "analysisDirectionMetrics",
      `${state.directionFilter}: ${formatSigned(selectedSummary.netPnl)} · PF ${round2(selectedSummary.profitFactor)} · ${round1(selectedSummary.winRate)}% win | Long ${formatSigned(edge.long.netPnl)} / Short ${formatSigned(edge.short.netPnl)}`
    );

    const exits = scope.directions[state.directionFilter].exitDistribution[state.exitReasonFilter] ||
      scope.directions[state.directionFilter].exitDistribution.ALL;
    setText("analysisExitTarget", exitLabel(exits.target));
    setText("analysisExitStopLoss", exitLabel(exits.stopLoss));
    setText("analysisExitTime", exitLabel(exits.timeExit));

    const consistency = scope.directions[state.directionFilter].dateConsistency;
    setText("analysisConsistency", consistency.classification);
    const bestDay = consistency.bestDay ? `${formatAnalysisDate(consistency.bestDay.date)} ${formatSigned(consistency.bestDay.netPoints)}` : "—";
    const worstDay = consistency.worstDay ? `${formatAnalysisDate(consistency.worstDay.date)} ${formatSigned(consistency.worstDay.netPoints)}` : "—";
    setText(
      "analysisConsistencyMetrics",
      `${round1(consistency.profitableDayPercentage)}% profitable days · Avg ${formatSigned(consistency.averageDailyNet)} | Best ${bestDay} | Worst ${worstDay}`
    );
  }

  function bestRrLabel(summary) {
    return `${summary.rr} · ${formatSigned(summary.netPnl)} · PF ${round2(summary.profitFactor)}`;
  }

  function exitLabel(summary) {
    return `${summary.count} · ${round1(summary.percentage)}%`;
  }

  function formatAnalysisDate(date) {
    return date ? formatDate(toUnixSeconds(date)) : "—";
  }

  function chartFilterLabel(tradeCount) {
    const direction = state.directionFilter === "ALL" ? "All" : state.directionFilter[0] + state.directionFilter.slice(1).toLowerCase();
    const date = state.dateFilter === "ALL" ? "all dates" : formatDate(toUnixSeconds(state.dateFilter));
    return `${state.rrFilter} · ${direction} trades · ${date} · ${tradeCount} plotted`;
  }

  function populateDateFilter() {
    const select = document.getElementById("dateFilter");
    const dates = [...new Set(state.data.candles.map((c) => dateKey(c.time)))].sort();
    dates.forEach((date) => {
      const option = document.createElement("option");
      option.value = date;
      option.textContent = formatDate(toUnixSeconds(date));
      select.appendChild(option);
    });
  }

  function addTradeMarkers(markers, t, dim) {
    const isLong = t.direction === "LONG";
    const dirColor = isLong ? COLOR.teal : COLOR.red;
    const entryColor = dim ? (isLong ? COLOR.tealDim : COLOR.redDim) : dirColor;

    markers.push({
      time: t.entryTime,
      position: isLong ? "belowBar" : "aboveBar",
      color: entryColor,
      shape: isLong ? "arrowUp" : "arrowDown",
      text: dim ? "" : `${t.direction} ${formatNumber(t.entryPrice)}`,
      size: dim ? 0.9 : 1.3,
    });

    if (t.exitTime !== undefined && t.exitTime !== null) {
      const pnlPositive = isNum(t.pnl) ? t.pnl > 0 : null;
      const exitColor = dim
        ? "rgba(167,177,194,0.25)"
        : pnlPositive === null
        ? COLOR.amber
        : pnlPositive
        ? COLOR.teal
        : COLOR.red;

      markers.push({
        time: t.exitTime,
        position: isLong ? "aboveBar" : "belowBar",
        color: exitColor,
        shape: "circle",
        text: dim ? "" : `EXIT ${formatNumber(t.exitPrice)}${t.exitReason ? " · " + prettyReason(t.exitReason) : ""}`,
        size: dim ? 0.9 : 1.1,
      });
    }
  }

  function addTradeLevelLines(t, dim, isSelected) {
    const spanFrom = t.entryTime;
    const spanTo = (t.exitTime !== undefined && t.exitTime !== null) ? t.exitTime : t.entryTime + state.barIntervalSec;

    if (isNum(t.stopLoss)) {
      const series = state.chart.addLineSeries({
        color: dim ? "rgba(240,84,106,0.22)" : COLOR.red,
        lineWidth: isSelected ? 2 : 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      series.setData([
        { time: spanFrom, value: t.stopLoss },
        { time: spanTo, value: t.stopLoss },
      ]);
      state.overlaySeries.push(series);
    }

    if (isNum(t.target)) {
      const series = state.chart.addLineSeries({
        color: dim ? "rgba(47,214,167,0.22)" : COLOR.teal,
        lineWidth: isSelected ? 2 : 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      series.setData([
        { time: spanFrom, value: t.target },
        { time: spanTo, value: t.target },
      ]);
      state.overlaySeries.push(series);
    }
  }

  function clearOverlaySeries() {
    state.overlaySeries.forEach((s) => {
      try {
        state.chart.removeSeries(s);
      } catch (e) {
        /* series already gone */
      }
    });
    state.overlaySeries = [];
  }

  // ---------------------------------------------------------------------
  // Trade table
  // ---------------------------------------------------------------------
  function refreshTable() {
    const trades = currentFilteredTrades();
    const tbody = document.getElementById("tradeTableBody");
    tbody.innerHTML = "";

    if (!trades.length) {
      const tr = document.createElement("tr");
      tr.className = "empty-row";
      tr.innerHTML = `<td colspan="10">No trades match the current filter.</td>`;
      tbody.appendChild(tr);
      return;
    }

    const frag = document.createDocumentFragment();
    trades.forEach((t) => {
      const tr = document.createElement("tr");
      tr.dataset.tradeId = t.id;
      if (t.id === state.selectedTradeId) tr.classList.add("selected");

      const pnlClass = isNum(t.pnl) ? (t.pnl > 0 ? "positive" : t.pnl < 0 ? "negative" : "") : "";
      const reasonKey = (t.exitReason || "").toLowerCase().replace(/\s+/g, "_");

      tr.innerHTML = `
        <td>${t.id}</td>
        <td><span class="dir-tag ${t.direction === "LONG" ? "long" : "short"}">${t.direction}</span></td>
        <td>${formatDateTime(t.entryTime)}</td>
        <td>${formatNumber(t.entryPrice)}</td>
        <td>${isNum(t.stopLoss) ? formatNumber(t.stopLoss) : "—"}</td>
        <td>${isNum(t.target) ? formatNumber(t.target) : "—"}</td>
        <td>${t.exitTime ? formatDateTime(t.exitTime) : "—"}</td>
        <td>${isNum(t.exitPrice) ? formatNumber(t.exitPrice) : "—"}</td>
        <td>${t.exitReason ? `<span class="reason-tag ${reasonKey}">${prettyReason(t.exitReason)}</span>` : "—"}</td>
        <td class="col-pnl pnl-cell ${pnlClass}">${isNum(t.pnl) ? formatSigned(t.pnl) : "—"}</td>
      `;

      tr.addEventListener("click", () => selectTrade(t.id));
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  // ---------------------------------------------------------------------
  // Selection / detail panel / zoom
  // ---------------------------------------------------------------------
  function selectTrade(id) {
    const trade = activeScenario().trades.find((t) => t.id === id);
    if (!trade) return;

    state.selectedTradeId = id;
    refreshOverlays();
    refreshTable();
    renderDetailPanel(trade);
    zoomToTrade(trade);
  }

  function deselectTrade() {
    state.selectedTradeId = null;
    refreshOverlays();
    refreshTable();
    renderDetailPanel(null);
    state.chart.timeScale().fitContent();
    document.getElementById("chartSubtitle").textContent = chartFilterLabel(filteredDashboardTrades().length);
  }

  function zoomToTrade(trade) {
    const pad = state.barIntervalSec * 6;
    const to = (trade.exitTime !== undefined && trade.exitTime !== null ? trade.exitTime : trade.entryTime) + pad;
    const from = trade.entryTime - pad;
    state.chart.timeScale().setVisibleRange({ from, to });
    document.getElementById("chartSubtitle").textContent =
      `Focused on trade #${trade.id} — ${trade.direction} · ${prettyReason(trade.exitReason || "")}`;
  }

  function renderDetailPanel(trade) {
    const empty = document.getElementById("detailEmpty");
    const content = document.getElementById("detailContent");

    if (!trade) {
      empty.hidden = false;
      content.hidden = true;
      return;
    }

    empty.hidden = true;
    content.hidden = false;

    setText("detailId", `#${trade.id}`);
    const dirEl = document.getElementById("detailDirection");
    dirEl.textContent = trade.direction;
    dirEl.className = "detail-direction " + (trade.direction === "LONG" ? "long" : "short");

    const pnlEl = document.getElementById("detailPnlValue");
    pnlEl.textContent = isNum(trade.pnl) ? formatSigned(trade.pnl) : "—";
    pnlEl.className = "detail-pnl-value " + (isNum(trade.pnl) ? (trade.pnl > 0 ? "positive" : "negative") : "");

    setText("detailEntryTime", formatDateTime(trade.entryTime));
    setText("detailEntryPrice", formatNumber(trade.entryPrice));
    setText("detailStopLoss", isNum(trade.stopLoss) ? formatNumber(trade.stopLoss) : "Not set");
    setText("detailTarget", isNum(trade.target) ? formatNumber(trade.target) : "Not set");
    setText("detailExitTime", trade.exitTime ? formatDateTime(trade.exitTime) : "—");
    setText("detailExitPrice", isNum(trade.exitPrice) ? formatNumber(trade.exitPrice) : "—");
    setText("detailExitReason", trade.exitReason ? prettyReason(trade.exitReason) : "—");
    setText("detailQty", isNum(trade.qty) ? trade.qty : "—");

    if (isNum(trade.stopLoss) && isNum(trade.target)) {
      const risk = Math.abs(trade.entryPrice - trade.stopLoss);
      const reward = Math.abs(trade.target - trade.entryPrice);
      setText("detailRR", risk > 0 ? `1 : ${round2(reward / risk)}` : "—");
    } else {
      setText("detailRR", "—");
    }
  }

  // ---------------------------------------------------------------------
  // Static controls: filters, search, deselect button
  // ---------------------------------------------------------------------
  function bindStaticControls() {
    document.querySelectorAll("#directionFilter .segmented-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#directionFilter .segmented-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.directionFilter = btn.dataset.filter;
        refreshDashboard();
      });
    });

    document.getElementById("dateFilter").addEventListener("change", (e) => {
      state.dateFilter = e.target.value;
      refreshDashboard();
    });

    document.getElementById("rrFilter").addEventListener("change", (e) => {
      state.rrFilter = e.target.value;
      state.selectedTradeId = null;
      renderDetailPanel(null);
      refreshDashboard();
    });

    document.getElementById("exitReasonFilter").addEventListener("change", (e) => {
      state.exitReasonFilter = e.target.value;
      refreshDashboard();
    });

    document.getElementById("tradeSearch").addEventListener("input", (e) => {
      state.searchTerm = e.target.value;
      refreshOverlays();
      refreshTable();
    });

    document.getElementById("btnDeselect").addEventListener("click", deselectTrade);

    document.getElementById("btnExpandChart").addEventListener("click", () => {
      const chartColumn = document.querySelector(".chart-column");
      if (document.fullscreenElement) document.exitFullscreen();
      else chartColumn.requestFullscreen();
    });

    document.addEventListener("fullscreenchange", () => {
      const expanded = Boolean(document.fullscreenElement);
      document.getElementById("btnExpandChart").textContent = expanded ? "Exit full screen" : "Full screen";
      setTimeout(() => state.chart && state.chart.applyOptions({ autoSize: true }), 0);
    });
  }

  // ---------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------
  function isNum(v) {
    return typeof v === "number" && !Number.isNaN(v);
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function formatNumber(n) {
    if (!isNum(n)) return "—";
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatSigned(n) {
    if (!isNum(n)) return "—";
    const sign = n > 0 ? "+" : "";
    return sign + formatNumber(n);
  }

  function formatDate(unixSeconds) {
    const d = new Date(unixSeconds * 1000);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
  }

  function formatDateTime(unixSeconds) {
    const d = new Date(unixSeconds * 1000);
    return (
      d.toLocaleDateString(undefined, {
        timeZone: "UTC",
        month: "short",
        day: "2-digit"
      }) +
      " " +
      d.toLocaleTimeString(undefined, {
        timeZone: "UTC",
        hour: "2-digit",
        minute: "2-digit"
      })
    );
}
  function prettyReason(reason) {
    return String(reason)
      .replace(/_/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function setText(id, value) {
    document.getElementById(id).textContent = value;
  }
})();
