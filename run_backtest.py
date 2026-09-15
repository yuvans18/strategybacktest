import importlib
import json
import shutil
from datetime import datetime
from statistics import median
import sys
from pathlib import Path

from backtester_engine import execute_trade, calculate_metrics
from data_manager import DataManager


DATA_MANAGER = DataManager("data")

DEFAULT_SYMBOL = "NIFTY"
DEFAULT_TIMEFRAME = "15m"
RR_SCENARIOS = (1.0, 2.0, 3.0, 4.0)
DEFAULT_RR = 2.0

FRONTEND_DATA_FILE = Path("frontend/data.json")


def iso(value):
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def calculate_scenario_metrics(trades):
    """Add R:R report fields without changing the shared backtest engine."""
    metrics = calculate_metrics(trades)
    points = [float(trade["Points"]) for trade in trades]
    metrics.update({
        "longTrades": sum(str(trade.get("Direction", "")).upper() == "LONG" for trade in trades),
        "shortTrades": sum(str(trade.get("Direction", "")).upper() == "SHORT" for trade in trades),
        "averageTrade": sum(points) / len(points) if points else 0,
        "largestWin": max(points) if points else 0,
        "largestLoss": min(points) if points else 0,
    })
    return metrics


def filter_trades(trades, direction="ALL", trade_date=None):
    return [
        trade for trade in trades
        if (direction == "ALL" or str(trade.get("Direction", "")).upper() == direction)
        and (trade_date is None or str(trade["Trade Date"]) == trade_date)
    ]


def metric_summary(trades):
    metrics = calculate_scenario_metrics(trades)
    return {
        key: metrics[key]
        for key in (
            "totalTrades", "longTrades", "shortTrades", "winningTrades",
            "losingTrades", "winRate", "grossProfit", "grossLoss", "netPnl",
            "profitFactor", "maxDrawdown", "averageTrade", "largestWin", "largestLoss",
        )
    }


def exit_distribution(trades):
    total = len(trades)
    distribution = {
        reason: {
            "count": sum(trade.get("Exit Reason") == label for trade in trades),
            "percentage": (sum(trade.get("Exit Reason") == label for trade in trades) / total * 100) if total else 0,
        }
        for reason, label in (("target", "Target"), ("stopLoss", "Stop Loss"), ("timeExit", "Time Exit"))
    }
    by_filter = {"ALL": distribution}
    for reason, label in (("TARGET", "target"), ("STOP LOSS", "stopLoss"), ("TIME EXIT", "timeExit")):
        count = distribution[label]["count"]
        by_filter[reason] = {
            key: {"count": value["count"] if key == label else 0,
                  "percentage": 100 if key == label and count else 0}
            for key, value in distribution.items()
        }
    return by_filter


def date_consistency(trades):
    daily_net = {}
    for trade in trades:
        date = str(trade["Trade Date"])
        daily_net[date] = daily_net.get(date, 0) + float(trade["Points"])

    values = list(daily_net.values())
    profitable = sum(value > 0 for value in values)
    losing = sum(value < 0 for value in values)
    flat = sum(value == 0 for value in values)
    profitable_pct = profitable / len(values) * 100 if values else 0
    average_daily_net = sum(values) / len(values) if values else 0

    # Simple, documented thresholds: >=60% profitable and positive average is
    # Consistent; >=50% with positive average is Moderately consistent; a
    # positive average below 50% is Concentrated; otherwise Inconsistent.
    if average_daily_net > 0 and profitable_pct >= 60:
        classification = "Consistent"
    elif average_daily_net > 0 and profitable_pct >= 50:
        classification = "Moderately consistent"
    elif average_daily_net > 0:
        classification = "Concentrated"
    else:
        classification = "Inconsistent"

    best_date = max(daily_net, key=daily_net.get) if daily_net else None
    worst_date = min(daily_net, key=daily_net.get) if daily_net else None
    return {
        "classification": classification,
        "profitableDays": profitable,
        "losingDays": losing,
        "flatDays": flat,
        "profitableDayPercentage": profitable_pct,
        "averageDailyNet": average_daily_net,
        "medianDailyNet": median(values) if values else 0,
        "bestDay": {"date": best_date, "netPoints": daily_net[best_date]} if best_date else None,
        "worstDay": {"date": worst_date, "netPoints": daily_net[worst_date]} if worst_date else None,
    }


def direction_edge(long_summary, short_summary):
    """Rank with net points, profit factor, and win rate as equal evidence."""
    criteria = ("netPnl", "profitFactor", "winRate")
    long_score = sum(long_summary[key] > short_summary[key] for key in criteria)
    short_score = sum(short_summary[key] > long_summary[key] for key in criteria)
    stronger = "LONG" if long_score > short_score else "SHORT" if short_score > long_score else "EVEN"
    return {
        "long": long_summary,
        "short": short_summary,
        "strongerDirection": stronger,
        "evidence": "Net points, profit factor, and win rate each contribute one comparison point.",
    }


def build_strategy_analysis(scenario_trades, trading_dates):
    best_rr = {}
    for direction in ("ALL", "LONG", "SHORT"):
        candidates = []
        for rr in RR_SCENARIOS:
            summary = metric_summary(filter_trades(scenario_trades[rr], direction))
            candidates.append((rr, summary))
        rr, summary = max(
            candidates,
            key=lambda item: (item[1]["netPnl"], item[1]["profitFactor"], item[1]["winRate"]),
        )
        best_rr[direction.lower()] = {"rr": f"1:{int(rr)}", **summary}

    scopes = {}
    for rr in RR_SCENARIOS:
        rr_key = f"1:{int(rr)}"
        scopes[rr_key] = {}
        for date in ["ALL", *trading_dates]:
            date_value = None if date == "ALL" else date
            directions = {}
            for direction in ("ALL", "LONG", "SHORT"):
                scoped_trades = filter_trades(scenario_trades[rr], direction, date_value)
                directions[direction] = {
                    "summary": metric_summary(scoped_trades),
                    "exitDistribution": exit_distribution(scoped_trades),
                    "dateConsistency": date_consistency(scoped_trades),
                }
            scopes[rr_key][date] = {
                "directions": directions,
                "directionEdge": direction_edge(
                    directions["LONG"]["summary"], directions["SHORT"]["summary"]
                ),
            }

    return {"bestRr": best_rr, "scopes": scopes}


def build_trade_json(trade, trade_id):
    points = float(trade["Points"])
    result = "WIN" if points > 0 else "LOSS" if points < 0 else "BREAKEVEN"

    signal_time = trade["Signal Candle Time (Cn)"]
    entry_time = trade["Entry Candle Time (Cn+1)"]
    exit_time = trade["Exit Time"]
    direction = str(trade.get("Direction", "Long")).upper()

    events = [
        {
            "type": "SIGNAL",
            "time": iso(signal_time),
            "price": float(trade["Signal Candle Close"]),
        },
        {
            "type": "ENTRY",
            "time": iso(entry_time),
            "price": float(trade["Entry"]),
            "direction": direction,
        },
        {
            "type": "STOP_LOSS_LEVEL",
            "time": iso(entry_time),
            "price": float(trade["Stop Loss"]),
        },
        {
            "type": "TARGET_LEVEL",
            "time": iso(entry_time),
            "price": float(trade["Target"]),
        },
        {
            "type": "EXIT",
            "time": iso(exit_time),
            "price": float(trade["Exit Price"]),
            "reason": trade["Exit Reason"].upper(),
        },
    ]

    return {
        "tradeId": trade_id,
        "date": iso(trade["Trade Date"]),
        "direction": direction,
        "gapPct": float(trade.get("Gap %", 0)),
        "pdc": float(trade.get("PDC", 0)),
        "todayOpen": float(trade.get("Today Open", 0)),
        "firstCandleTime": iso(trade.get("First Candle Time", signal_time)),
        "firstCandleHigh": float(trade.get("First Candle High", 0)),
        "signalTime": iso(signal_time),
        "signalPrice": float(trade["Signal Candle Close"]),
        "entryTime": iso(entry_time),
        "entryPrice": float(trade["Entry"]),
        "stopLoss": float(trade["Stop Loss"]),
        "risk": float(trade["Risk"]),
        "rr": float(trade["RR"]),
        "target": float(trade["Target"]),
        "exitTime": iso(exit_time),
        "exitPrice": float(trade["Exit Price"]),
        "exitReason": trade["Exit Reason"],
        "result": result,
        "pnl": points,
        "points": points,
        "events": events,
    }


def build_scenario_data(trades, metrics):
    trade_json = [
        build_trade_json(trade, trade_id)
        for trade_id, trade in enumerate(trades, start=1)
    ]

    equity_curve = []
    cumulative = 0.0
    for trade_id, trade in enumerate(trades, start=1):
        points = float(trade["Points"])
        cumulative += points
        equity_curve.append({
            "time": iso(trade["Exit Time"]),
            "tradeId": trade_id,
            "pnl": points,
            "cumulativePnl": cumulative,
        })

    return {
        "trades": trade_json,
        "metrics": metrics,
        "equityCurve": equity_curve,
    }


def build_frontend_data(df, scenario_results, strategy_analysis, strategy, symbol, timeframe):
    candles = []

    for _, row in df.iterrows():
        candles.append({
            "time": iso(row["time"]),
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": None,
        })

    default_result = scenario_results[DEFAULT_RR]

    start_date = df.iloc[0]["time"]
    end_date = df.iloc[-1]["time"]

    parameters = {
            "riskReward": DEFAULT_RR,
    }

    for attr, key in [
        ("CN_START_TIME", "cnStartTime"),
        ("BREAKOUT_CUTOFF_TIME", "breakoutCutoff"),
        ("TIME_EXIT_TIME", "timeExit"),
    ]:
        if hasattr(strategy, attr):
            parameters[key] = getattr(strategy, attr).strftime("%H:%M")

    now_iso = datetime.now().isoformat()

    return {
        "backtest": {
            "symbol": "NIFTY 50",
            "exchange": "NSE",
            "timeframe": timeframe,
            "strategy": strategy.STRATEGY_NAME,
            "startDate": iso(start_date),
            "endDate": iso(end_date),
            "lastRun": now_iso,
            "dateRange": {
                "from": iso(start_date),
                "to": iso(end_date),
            },
        },
        "strategy": {
            "name": strategy.STRATEGY_NAME,
            "description": "Results generated by Python backtesting engine.",
            "parameters": parameters,
        },
        "dataset": {
            "source": "1-minute master data",
            "symbol": symbol,
            "timeframe": timeframe,
            "candleCount": len(candles),
            "tradingDays": df["date"].nunique(),
        },
        "candles": candles,
        "trades": default_result["trades"],
        "metrics": default_result["metrics"],
        "equityCurve": default_result["equityCurve"],
        "defaultRr": "1:2",
        "rrScenarios": {
            f"1:{int(rr)}": scenario_results[rr]
            for rr in RR_SCENARIOS
        },
        "strategyAnalysis": strategy_analysis,
    }


def generate_standalone_html(frontend_data, strategy_name, output_path):
    frontend_dir = Path("frontend")
    index_file = frontend_dir / "index.html"
    style_file = frontend_dir / "style.css"
    app_file = frontend_dir / "app.js"

    if not (index_file.exists() and style_file.exists() and app_file.exists()):
        return False

    with open(index_file, "r", encoding="utf-8") as f:
        html = f.read()

    with open(style_file, "r", encoding="utf-8") as f:
        css = f.read()

    with open(app_file, "r", encoding="utf-8") as f:
        app_js = f.read()

    html = html.replace(
        '<link rel="stylesheet" href="style.css" />',
        f'<style>\n{css}\n</style>'
    )

    # Scan results/ directory to embed all available strategies for offline switching
    strategies_dict = {}
    results_dir = Path("results")
    if results_dir.exists():
        for s_dir in results_dir.iterdir():
            if s_dir.is_dir():
                s_json = s_dir / "data.json"
                if s_json.exists():
                    try:
                        with open(s_json, "r", encoding="utf-8") as f:
                            strategies_dict[s_dir.name] = json.load(f)
                    except Exception:
                        pass
    strategies_dict[strategy_name] = frontend_data

    inline_script = (
        f'<script>\n'
        f'window.__BACKTEST_STRATEGIES__ = {json.dumps(strategies_dict)};\n'
        f'window.__BACKTEST_DATA__ = {json.dumps(frontend_data)};\n'
        f'window.__CURRENT_STRATEGY_ID__ = "{strategy_name}";\n'
        f'</script>\n'
        f'<script>\n{app_js}\n</script>'
    )

    html = html.replace('<script src="app.js"></script>', inline_script)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)

    return True


def main():
    if len(sys.argv) < 2:
        print("Usage:")
        print("python run_backtest.py <strategy_name>")
        return

    strategy_name = sys.argv[1]

    try:
        strategy = importlib.import_module(f"strategies.{strategy_name}")
    except ModuleNotFoundError:
        print(f"Strategy not found: {strategy_name}")
        return

    symbol = getattr(strategy, "SYMBOL", DEFAULT_SYMBOL)
    timeframe = getattr(strategy, "TIMEFRAME", DEFAULT_TIMEFRAME)
    timeframes = getattr(strategy, "TIMEFRAMES", [timeframe])

    print()
    print(f"Loading {symbol} {timeframe} data...")

    datasets = DATA_MANAGER.get_multiple(symbol, timeframes)

    df = datasets[timeframe].copy()
    df["date"] = df["time"].dt.date

    signals = []
    trading_days = sorted(df["date"].unique())

    directional = getattr(strategy, "SUPPORTS_DIRECTIONS", False)

    for i in range(1, len(trading_days)):
        current_date = trading_days[i]
        previous_date = trading_days[i - 1]

        day_df = df[df["date"] == current_date].copy()
        previous_day_df = df[df["date"] == previous_date].copy()

        if day_df.empty or previous_day_df.empty:
            continue

        previous_close = float(previous_day_df.iloc[-1]["close"])

        signal = strategy.check_signal(
            day_df,
            previous_close,
            data_manager=DATA_MANAGER,
            datasets=datasets,
        )

        if signal is None:
            continue

        signals.append({
            "day_df": day_df,
            "trade_date": current_date,
            "previous_close": previous_close,
            "signal": signal,
        })

    scenario_results = {}
    scenario_trades = {}
    for rr in RR_SCENARIOS:
        trades = []
        for setup in signals:
            signal = setup["signal"]
            if directional:
                trade = execute_trade(
                    setup["day_df"], signal["signal_row"], rr=rr,
                    direction=signal["direction"], stop_loss=signal["stop_loss"],
                    time_exit_df=datasets.get("5m"),
                    time_exit_time=getattr(strategy, "TIME_EXIT_TIME", None),
                )
            else:
                trade = execute_trade(setup["day_df"], signal["signal_row"], rr=rr)

            if trade is None:
                continue

            trade["Trade Date"] = setup["trade_date"]
            trade["Direction"] = trade.get("Direction", "Long")
            trade["Gap %"] = signal.get("gap_pct", 0)
            trade["PDC"] = setup["previous_close"]
            trade["Today Open"] = float(setup["day_df"].iloc[0]["open"])
            trade["First Candle Time"] = setup["day_df"].iloc[0]["time"]
            trade["First Candle High"] = signal.get(
                "first_candle_high", signal.get("cn_high", setup["day_df"].iloc[0]["high"])
            )
            trades.append(trade)

        metrics = calculate_scenario_metrics(trades)
        scenario_results[rr] = build_scenario_data(trades, metrics)

        scenario_trades[rr] = trades

    strategy_analysis = build_strategy_analysis(
        scenario_trades,
        [str(date) for date in trading_days],
    )

    frontend_data = build_frontend_data(
        df,
        scenario_results,
        strategy_analysis,
        strategy,
        symbol,
        timeframe,
    )

    with open("data.json", "w", encoding="utf-8") as f:
        json.dump(frontend_data, f, indent=2)

    try:
        shutil.copy2("data.json", FRONTEND_DATA_FILE)
        dashboard_updated = True
    except (FileNotFoundError, PermissionError):
        dashboard_updated = False

    # Save per-strategy result folder: results/<strategy_name>/
    results_dir = Path("results") / strategy_name
    results_dir.mkdir(parents=True, exist_ok=True)

    strategy_data_path = results_dir / "data.json"
    with open(strategy_data_path, "w", encoding="utf-8") as f:
        json.dump(frontend_data, f, indent=2)

    report_html_path = results_dir / "Backtest_Report.html"
    html_generated = generate_standalone_html(frontend_data, strategy_name, report_html_path)

    print()
    print("=" * 50)
    print(strategy.STRATEGY_NAME)
    print("=" * 50)
    print("Data source:   1-minute master")
    print(f"Symbol:        {symbol}")
    print(f"Timeframe:     {timeframe}")
    print(f"Total candles: {len(df)}")
    print(f"Signals:       {len(signals)}")
    for rr in RR_SCENARIOS:
        metrics = scenario_results[rr]["metrics"]
        print(f"\nR:R 1:{int(rr)}")
        print(f"Total trades:  {metrics['totalTrades']}")
        print(f"LONG / SHORT:  {metrics['longTrades']} / {metrics['shortTrades']}")
        print(f"Wins / Losses: {metrics['winningTrades']} / {metrics['losingTrades']}")
        print(f"Win rate:      {metrics['winRate']:.2f}%")
        print(f"Net points:    {metrics['netPnl']:.2f}")
        print(f"Profit factor: {metrics['profitFactor']:.4f}")
    print()
    print("data.json created.")
    print("Dashboard data updated." if dashboard_updated else
          "Dashboard data copy skipped (frontend path unavailable).")
    print(f"Per-strategy results saved to: {results_dir}/")
    print(f"  - {strategy_data_path}")
    if html_generated:
        print(f"  - {report_html_path}")
    print("=" * 50)


if __name__ == "__main__":
    main()
