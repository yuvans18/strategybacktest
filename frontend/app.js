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
    fromDate: "",
    toDate: "",
    entryFromTime: "",
    entryToTime: "",
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
    const initialStrategyId = window.__CURRENT_STRATEGY_ID__ || "1_pm_strategy";
    await loadStrategy(initialStrategyId);
    if (state.data?.candles) {
      initChart(state.data.candles);
      refreshDashboard();
    }
  }

  async function loadStrategy(strategyId) {
    let data = null;

    if (window.__BACKTEST_STRATEGIES__ && window.__BACKTEST_STRATEGIES__[strategyId]) {
      data = window.__BACKTEST_STRATEGIES__[strategyId];
    } else if (window.__BACKTEST_DATA__ && (window.__CURRENT_STRATEGY_ID__ === strategyId || !strategyId)) {
      data = window.__BACKTEST_DATA__;
    } else {
      try {
        const res = await fetch(`results/${strategyId}/data.json`);
        data = await res.json();
      } catch (e1) {
        try {
          const res2 = await fetch("data.json");
          data = await res2.json();
        } catch (e2) {
          renderFatalError(e2);
          return;
        }
      }
    }

    state.selectedStrategyId = strategyId;
    state.data = normalizeData(data);
    state.barIntervalSec = inferBarInterval(state.data.candles);

    const stratSelect = document.getElementById("strategySelect");
    if (stratSelect && stratSelect.value !== strategyId) {
      stratSelect.value = strategyId;
    }

    renderHeader(state.data.backtest, state.data.candles);

    if (state.chart && state.candleSeries) {
      state.selectedTradeId = null;
      renderDetailPanel(null);
      refreshDashboard();
    }
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
    setText("metaSymbol", backtest.symbol || "—");
    setText("metaTimeframe", backtest.timeframe || "—");

    const metaStrat = document.getElementById("metaStrategy");
    if (metaStrat) metaStrat.textContent = backtest.strategy || "—";

    let from = backtest.startDate;
    let to = backtest.endDate;
    if (!from && candles.length) from = candles[0].time;
    if (!to && candles.length) to = candles[candles.length - 1].time;

    setText(
      "metaDateRange",
      from && to ? `${formatDate(from)} – ${formatDate(to)}` : "—"
    );

    const rawLastRun = backtest.lastRun || backtest.timestamp || backtest.runTimestamp;
    const lastRunDiv = document.getElementById("lastRunDivider");
    const lastRunField = document.getElementById("lastRunField");
    const lastRunVal = document.getElementById("metaLastRun");

    if (rawLastRun && lastRunVal && lastRunField) {
      const d = new Date(rawLastRun);
      if (!isNaN(d.getTime())) {
        lastRunVal.textContent = d.toLocaleDateString(undefined, {
          month: "short",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
        lastRunField.hidden = false;
        if (lastRunDiv) lastRunDiv.hidden = false;
      } else {
        lastRunVal.textContent = String(rawLastRun);
        lastRunField.hidden = false;
        if (lastRunDiv) lastRunDiv.hidden = false;
      }
    } else if (lastRunField) {
      lastRunField.hidden = true;
      if (lastRunDiv) lastRunDiv.hidden = true;
    }

    document.title = `Backtester · ${backtest.strategy || backtest.symbol || "Strategy"}`;
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
      return state.data.rrScenarios[state.data.defaultRr || "1:2"] || state.data.rrScenarios["1:2"];
    }
    return state.data.rrScenarios[state.rrFilter] || state.data.rrScenarios[state.data.defaultRr || "1:2"] || state.data.rrScenarios["1:2"];
  }

  function filteredCandles() {
    if (!state.fromDate && !state.toDate) return state.data.candles;
    return state.data.candles.filter((c) => {
      const d = dateKey(c.time);
      if (state.fromDate && d < state.fromDate) return false;
      if (state.toDate && d > state.toDate) return false;
      return true;
    });
  }

  function filteredDashboardTrades() {
    return activeScenario().trades.filter((t) => {
      if (state.directionFilter !== "ALL" && t.direction !== state.directionFilter) return false;

      if (t.entryTime) {
        const entryIso = new Date(t.entryTime * 1000).toISOString();
        const entryDate = entryIso.slice(0, 10);
        const entryTime = entryIso.slice(11, 16);

        if (state.fromDate && entryDate < state.fromDate) return false;
        if (state.toDate && entryDate > state.toDate) return false;
        if (state.entryFromTime && entryTime < state.entryFromTime) return false;
        if (state.entryToTime && entryTime >= state.entryToTime) return false;
      }

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

      addTradeMarkers(markers, t, dim, isSelected);
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
    const dateLabel = (state.fromDate || state.toDate)
      ? `${state.fromDate || "Start"} to ${state.toDate || "End"}`
      : "ALL DATES";
    const timeLabel = (state.entryFromTime || state.entryToTime)
      ? ` [${state.entryFromTime || "00:00"}-${state.entryToTime || "23:59"}]`
      : "";
    const exitReason = state.exitReasonFilter === "ALL" ? "ALL EXIT REASONS" : state.exitReasonFilter;
    return `R:R ${state.rrFilter} — ${state.directionFilter} — ${dateLabel}${timeLabel} — ${exitReason}`;
  }

  function get15mWindowLabel(unixSec) {
    if (!unixSec) return "Unknown";
    const d = new Date(unixSec * 1000);
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    const startMin = Math.floor(m / 15) * 15;
    let endH = h;
    let endMin = startMin + 15;
    if (endMin >= 60) {
      endH = (h + 1) % 24;
      endMin = 0;
    }
    const formatHM = (hour, min) => `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    return `${formatHM(h, startMin)}–${formatHM(endH, endMin)}`;
  }

  function renderStrategyAnalysis() {
    const analysis = state.data?.strategyAnalysis;
    const trades = filteredDashboardTrades();
    const rrLabel = state.rrFilter === "ALL" ? "ALL R:R" : state.rrFilter;
    const dateLabel = (state.fromDate || state.toDate)
      ? `${state.fromDate || "Start"} to ${state.toDate || "End"}`
      : "ALL DATES";
    const timeLabel = (state.entryFromTime || state.entryToTime)
      ? ` [${state.entryFromTime || "00:00"}-${state.entryToTime || "23:59"}]`
      : "";

    setText("analysisScope", `R:R ${rrLabel} — ${state.directionFilter} — ${dateLabel}${timeLabel}`);

    if (analysis && analysis.bestRr) {
      const best = analysis.bestRr;
      setText("analysisBestOverall", bestRrLabel(best.all));
      setText("analysisBestLong", bestRrLabel(best.long));
      setText("analysisBestShort", bestRrLabel(best.short));
    }

    // 1. Dynamic Direction Edge
    const longTrades = trades.filter((t) => t.direction === "LONG");
    const shortTrades = trades.filter((t) => t.direction === "SHORT");
    const longMetrics = calculateMetrics(longTrades);
    const shortMetrics = calculateMetrics(shortTrades);

    let longScore = 0;
    let shortScore = 0;
    if (longMetrics.netPnl > shortMetrics.netPnl) longScore++;
    else if (shortMetrics.netPnl > longMetrics.netPnl) shortScore++;
    if (longMetrics.profitFactor > shortMetrics.profitFactor) longScore++;
    else if (shortMetrics.profitFactor > longMetrics.profitFactor) shortScore++;
    if (longMetrics.winRate > shortMetrics.winRate) longScore++;
    else if (shortMetrics.winRate > longMetrics.winRate) shortScore++;

    const edgeLabel = longScore > shortScore
      ? "LONG stronger edge"
      : shortScore > longScore
      ? "SHORT stronger edge"
      : "LONG / SHORT evenly matched";

    setText("analysisDirectionEdge", edgeLabel);
    setText(
      "analysisDirectionMetrics",
      `${state.directionFilter}: ${formatSigned(calculateMetrics(trades).netPnl)} | Long ${formatSigned(longMetrics.netPnl)} / Short ${formatSigned(shortMetrics.netPnl)}`
    );

    // 2. Streaks & Exit Distribution
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    let currWin = 0;
    let currLoss = 0;

    // Chronological order by entryTime
    const sortedTrades = [...trades].sort((a, b) => (a.entryTime || 0) - (b.entryTime || 0));
    sortedTrades.forEach((t) => {
      const pnl = t.pnl || 0;
      if (pnl > 0) {
        currWin++;
        currLoss = 0;
        if (currWin > maxWinStreak) maxWinStreak = currWin;
      } else if (pnl < 0) {
        currLoss++;
        currWin = 0;
        if (currLoss > maxLossStreak) maxLossStreak = currLoss;
      }
    });

    setText("analysisMaxWinStreak", `${maxWinStreak} ${maxWinStreak === 1 ? "win" : "wins"}`);
    setText("analysisMaxLossStreak", `${maxLossStreak} ${maxLossStreak === 1 ? "loss" : "losses"}`);

    const total = trades.length;
    const countTarget = trades.filter((t) => normalizeExitReason(t.exitReason) === "TARGET").length;
    const countSL = trades.filter((t) => normalizeExitReason(t.exitReason) === "STOP LOSS").length;
    const countTime = trades.filter((t) => normalizeExitReason(t.exitReason) === "TIME EXIT").length;

    const pct = (c) => total ? round1((c / total) * 100) : 0;
    setText("analysisExitTarget", `${countTarget} · ${pct(countTarget)}%`);
    setText("analysisExitStopLoss", `${countSL} · ${pct(countSL)}%`);
    setText("analysisExitTime", `${countTime} · ${pct(countTime)}%`);

    // 3. Dynamic Daily Performance
    const dailyMap = {};
    trades.forEach((t) => {
      const dKey = dateKey(t.date || t.entryTime);
      if (!dailyMap[dKey]) {
        dailyMap[dKey] = { date: dKey, trades: 0, wins: 0, losses: 0, netPoints: 0 };
      }
      const d = dailyMap[dKey];
      d.trades++;
      const pnl = t.pnl || 0;
      if (pnl > 0) d.wins++;
      if (pnl < 0) d.losses++;
      d.netPoints += pnl;
    });

    const dailyList = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
    const dailyNets = dailyList.map((d) => d.netPoints);

    const profDays = dailyList.filter((d) => d.netPoints > 0).length;
    const lossDays = dailyList.filter((d) => d.netPoints < 0).length;
    const profPct = dailyList.length ? (profDays / dailyList.length) * 100 : 0;
    const avgDaily = dailyList.length ? dailyNets.reduce((a, b) => a + b, 0) / dailyList.length : 0;

    let medianDaily = 0;
    if (dailyNets.length > 0) {
      const sortedNets = [...dailyNets].sort((a, b) => a - b);
      const mid = Math.floor(sortedNets.length / 2);
      medianDaily = sortedNets.length % 2 !== 0
        ? sortedNets[mid]
        : (sortedNets[mid - 1] + sortedNets[mid]) / 2;
    }

    let classification = "Inconsistent";
    if (avgDaily > 0 && profPct >= 60) classification = "Consistent";
    else if (avgDaily > 0 && profPct >= 50) classification = "Moderately consistent";
    else if (avgDaily > 0) classification = "Concentrated";

    let bestDayObj = null;
    let worstDayObj = null;
    dailyList.forEach((d) => {
      if (!bestDayObj || d.netPoints > bestDayObj.netPoints) bestDayObj = d;
      if (!worstDayObj || d.netPoints < worstDayObj.netPoints) worstDayObj = d;
    });

    setText("analysisConsistency", classification);
    setText("analysisBestDay", bestDayObj ? `${formatAnalysisDate(bestDayObj.date)} (${formatSigned(bestDayObj.netPoints)} pts)` : "—");
    setText("analysisWorstDay", worstDayObj ? `${formatAnalysisDate(worstDayObj.date)} (${formatSigned(worstDayObj.netPoints)} pts)` : "—");
    setText("analysisDayCounts", `${profDays} prof / ${lossDays} loss (${dailyList.length} total)`);
    setText("analysisAvgDailyNet", formatSigned(avgDaily));
    setText("analysisMedianDailyNet", formatSigned(medianDaily));

    // Render Compact Daily Performance Table
    const dailyTbody = document.getElementById("dailyTableBody");
    if (dailyTbody) {
      dailyTbody.innerHTML = "";
      if (!dailyList.length) {
        dailyTbody.innerHTML = `<tr><td colspan="5" class="empty-row">No daily performance data</td></tr>`;
      } else {
        const frag = document.createDocumentFragment();
        [...dailyList].reverse().forEach((d) => {
          const tr = document.createElement("tr");
          const pnlClass = d.netPoints > 0 ? "positive" : (d.netPoints < 0 ? "negative" : "");
          tr.innerHTML = `
            <td>${formatAnalysisDate(d.date)}</td>
            <td>${d.trades}</td>
            <td class="win-num">${d.wins}</td>
            <td class="loss-num">${d.losses}</td>
            <td class="col-pnl pnl-cell ${pnlClass}">${formatSigned(d.netPoints)}</td>
          `;
          frag.appendChild(tr);
        });
        dailyTbody.appendChild(frag);
      }
    }

    // 4. Dynamic Entry Time Analysis (15m Buckets)
    const timeBucketMap = {};
    trades.forEach((t) => {
      const windowLabel = get15mWindowLabel(t.entryTime);
      if (!timeBucketMap[windowLabel]) {
        timeBucketMap[windowLabel] = {
          window: windowLabel,
          trades: 0,
          wins: 0,
          losses: 0,
          netPoints: 0,
          grossProfit: 0,
          grossLoss: 0,
        };
      }
      const b = timeBucketMap[windowLabel];
      b.trades++;
      const pnl = t.pnl || 0;
      if (pnl > 0) {
        b.wins++;
        b.grossProfit += pnl;
      } else if (pnl < 0) {
        b.losses++;
        b.grossLoss += Math.abs(pnl);
      }
      b.netPoints += pnl;
    });

    const bucketList = Object.values(timeBucketMap)
      .filter((b) => {
        const startHM = b.window.slice(0, 5);
        if (state.entryFromTime && startHM < state.entryFromTime) return false;
        if (state.entryToTime && startHM >= state.entryToTime) return false;
        return true;
      })
      .sort((a, b) => a.window.localeCompare(b.window));
    bucketList.forEach((b) => {
      b.winRate = b.trades ? (b.wins / b.trades) * 100 : 0;
      b.avgTrade = b.trades ? b.netPoints / b.trades : 0;
      b.profitFactor = b.grossLoss > 0 ? b.grossProfit / b.grossLoss : (b.grossProfit > 0 ? Infinity : 0);
    });

    let bestWindowObj = null;
    let worstWindowObj = null;
    bucketList.forEach((b) => {
      if (!bestWindowObj || b.netPoints > bestWindowObj.netPoints) bestWindowObj = b;
      if (!worstWindowObj || b.netPoints < worstWindowObj.netPoints) worstWindowObj = b;
    });

    setText(
      "analysisBestWindow",
      bestWindowObj
        ? `${bestWindowObj.window} (${formatSigned(bestWindowObj.netPoints)} pts, ${bestWindowObj.trades} ${bestWindowObj.trades === 1 ? "trade" : "trades"})`
        : "—"
    );

    setText(
      "analysisWorstWindow",
      worstWindowObj
        ? `${worstWindowObj.window} (${formatSigned(worstWindowObj.netPoints)} pts, ${worstWindowObj.trades} ${worstWindowObj.trades === 1 ? "trade" : "trades"})`
        : "—"
    );

    // Render Compact Entry Time Breakdown Table
    const timeTbody = document.getElementById("timeTableBody");
    if (timeTbody) {
      timeTbody.innerHTML = "";
      if (!bucketList.length) {
        timeTbody.innerHTML = `<tr><td colspan="6" class="empty-row">No entry time data</td></tr>`;
      } else {
        const frag = document.createDocumentFragment();
        bucketList.forEach((b) => {
          const tr = document.createElement("tr");
          const pnlClass = b.netPoints > 0 ? "positive" : (b.netPoints < 0 ? "negative" : "");
          const pfStr = isFinite(b.profitFactor) ? round2(b.profitFactor) : (b.grossProfit > 0 ? "∞" : "0");
          tr.innerHTML = `
            <td>${b.window}</td>
            <td>${b.trades}</td>
            <td>${round1(b.winRate)}%</td>
            <td>${formatSigned(b.avgTrade)}</td>
            <td>${pfStr}</td>
            <td class="col-pnl pnl-cell ${pnlClass}">${formatSigned(b.netPoints)}</td>
          `;
          frag.appendChild(tr);
        });
        timeTbody.appendChild(frag);
      }
    }
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

  function addTradeMarkers(markers, t, dim, isSelected) {
    const isLong = t.direction === "LONG";
    const dirColor = isLong ? COLOR.teal : COLOR.red;
    const entryColor = dim ? (isLong ? COLOR.tealDim : COLOR.redDim) : dirColor;

    markers.push({
      time: t.entryTime,
      position: isLong ? "belowBar" : "aboveBar",
      color: entryColor,
      shape: isLong ? "arrowUp" : "arrowDown",
      text: isSelected ? `${t.direction} ${formatNumber(t.entryPrice)}` : "",
      size: isSelected ? 1.5 : (dim ? 0.8 : 1.1),
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
        text: isSelected ? `EXIT ${formatNumber(t.exitPrice)}${t.exitReason ? " · " + prettyReason(t.exitReason) : ""}` : "",
        size: isSelected ? 1.3 : (dim ? 0.7 : 0.9),
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

    const handleFilterInput = () => {
      state.fromDate = document.getElementById("fromDateFilter")?.value || "";
      state.toDate = document.getElementById("toDateFilter")?.value || "";
      state.entryFromTime = document.getElementById("entryFromTimeFilter")?.value || "";
      state.entryToTime = document.getElementById("entryToTimeFilter")?.value || "";
      refreshDashboard();
    };

    ["fromDateFilter", "toDateFilter", "entryFromTimeFilter", "entryToTimeFilter"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("change", handleFilterInput);
        el.addEventListener("input", handleFilterInput);
      }
    });

    const resetBtn = document.getElementById("btnResetFilters");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        state.fromDate = "";
        state.toDate = "";
        state.entryFromTime = "";
        state.entryToTime = "";
        state.directionFilter = "ALL";
        state.rrFilter = state.data?.defaultRr || "1:2";
        state.exitReasonFilter = "ALL";
        state.searchTerm = "";

        const fDate = document.getElementById("fromDateFilter"); if (fDate) fDate.value = "";
        const tDate = document.getElementById("toDateFilter"); if (tDate) tDate.value = "";
        const fTime = document.getElementById("entryFromTimeFilter"); if (fTime) fTime.value = "";
        const tTime = document.getElementById("entryToTimeFilter"); if (tTime) tTime.value = "";
        const rrSel = document.getElementById("rrFilter"); if (rrSel) rrSel.value = state.rrFilter;
        const exitSel = document.getElementById("exitReasonFilter"); if (exitSel) exitSel.value = "ALL";
        const searchInp = document.getElementById("tradeSearch"); if (searchInp) searchInp.value = "";

        document.querySelectorAll("#directionFilter .segmented-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.filter === "ALL");
        });

        refreshDashboard();
      });
    }

    const legacyDateFilter = document.getElementById("dateFilter");
    if (legacyDateFilter) {
      legacyDateFilter.addEventListener("change", (e) => {
        state.fromDate = e.target.value === "ALL" ? "" : e.target.value;
        state.toDate = e.target.value === "ALL" ? "" : e.target.value;
        refreshDashboard();
      });
    }

    const stratSelect = document.getElementById("strategySelect");
    if (stratSelect) {
      stratSelect.addEventListener("change", (e) => {
        loadStrategy(e.target.value);
      });
    }

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
