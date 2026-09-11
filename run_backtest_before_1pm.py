import importlib
import json
import shutil
import sys
from pathlib import Path

from backtester_engine import (
    load_data,
    execute_trade,
    calculate_metrics,
)


# --------------------------------------------------
# DEFAULT DATA FILE
# --------------------------------------------------

DEFAULT_DATA_FILE = Path(
    "data/Nifty 50-OHLC-15min-Data-14Oct2025(2.15PM)-9Sep2026(3.15PM).xlsx"
)


# --------------------------------------------------
# FRONTEND DATA FILE
# --------------------------------------------------

FRONTEND_DATA_FILE = Path(
    "/home/yuktrix/Music/frontend/data.json"
)


# --------------------------------------------------
# CONVERT DATE/TIME TO JSON FORMAT
# --------------------------------------------------

def iso(value):

    if hasattr(value, "isoformat"):
        return value.isoformat()

    return value


# --------------------------------------------------
# BUILD ONE TRADE FOR FRONTEND
# --------------------------------------------------

def build_trade_json(trade, trade_id):

    points = float(trade["Points"])

    if points > 0:
        result = "WIN"

    elif points < 0:
        result = "LOSS"

    else:
        result = "BREAKEVEN"

    signal_time = trade["Signal Candle Time (Cn)"]
    entry_time = trade["Entry Candle Time (Cn+1)"]
    exit_time = trade["Exit Time"]

    events = [

        {
            "type": "SIGNAL",
            "time": iso(signal_time),
            "price": float(
                trade["Signal Candle Close"]
            ),
        },

        {
            "type": "ENTRY",
            "time": iso(entry_time),
            "price": float(
                trade["Entry"]
            ),
            "direction": "LONG",
        },

        {
            "type": "STOP_LOSS_LEVEL",
            "time": iso(entry_time),
            "price": float(
                trade["Stop Loss"]
            ),
        },

        {
            "type": "TARGET_LEVEL",
            "time": iso(entry_time),
            "price": float(
                trade["Target"]
            ),
        },

        {
            "type": "EXIT",
            "time": iso(exit_time),
            "price": float(
                trade["Exit Price"]
            ),
            "reason": trade["Exit Reason"].upper(),
        },

    ]

    return {

        "tradeId": trade_id,

        "date": iso(
            trade["Trade Date"]
        ),

        "direction": "LONG",

        "gapPct": float(
            trade["Gap %"]
        ),

        "pdc": float(
            trade["PDC"]
        ),

        "todayOpen": float(
            trade["Today Open"]
        ),

        "firstCandleTime": iso(
            trade["First Candle Time"]
        ),

        "firstCandleHigh": float(
            trade["First Candle High"]
        ),

        "signalTime": iso(
            signal_time
        ),

        "signalPrice": float(
            trade["Signal Candle Close"]
        ),

        "entryTime": iso(
            entry_time
        ),

        "entryPrice": float(
            trade["Entry"]
        ),

        "stopLoss": float(
            trade["Stop Loss"]
        ),

        "risk": float(
            trade["Risk"]
        ),

        "rr": float(
            trade["RR"]
        ),

        "target": float(
            trade["Target"]
        ),

        "exitTime": iso(
            exit_time
        ),

        "exitPrice": float(
            trade["Exit Price"]
        ),

        "exitReason": trade[
            "Exit Reason"
        ],

        "result": result,

        "pnl": points,

        "points": points,

        "events": events,

    }


# --------------------------------------------------
# BUILD COMPLETE FRONTEND JSON
# --------------------------------------------------

def build_frontend_data(
    df,
    trades,
    metrics,
    strategy,
    data_file,
):

    # ------------------------------
    # CANDLES
    # ------------------------------

    candles = []

    for _, row in df.iterrows():

        candles.append({

            "time": iso(
                row["time"]
            ),

            "open": float(
                row["open"]
            ),

            "high": float(
                row["high"]
            ),

            "low": float(
                row["low"]
            ),

            "close": float(
                row["close"]
            ),

            "volume": None,

        })


    # ------------------------------
    # TRADES
    # ------------------------------

    trade_json = []

    for trade_id, trade in enumerate(
        trades,
        start=1,
    ):

        trade_json.append(
            build_trade_json(
                trade,
                trade_id,
            )
        )


    # ------------------------------
    # EQUITY CURVE
    # ------------------------------

    equity_curve = []

    cumulative = 0.0

    for trade_id, trade in enumerate(
        trades,
        start=1,
    ):

        points = float(
            trade["Points"]
        )

        cumulative += points

        equity_curve.append({

            "time": iso(
                trade["Exit Time"]
            ),

            "tradeId": trade_id,

            "pnl": points,

            "cumulativePnl": cumulative,

        })


    # ------------------------------
    # DATASET INFORMATION
    # ------------------------------

    start_date = df.iloc[0]["time"]

    end_date = df.iloc[-1]["time"]

    trading_days = df[
        "date"
    ].nunique()


    # ------------------------------
    # FRONTEND METRICS
    # ------------------------------

    frontend_metrics = {

        "totalTrades":
            metrics["totalTrades"],

        "wins":
            metrics["winningTrades"],

        "losses":
            metrics["losingTrades"],

        "winningTrades":
            metrics["winningTrades"],

        "losingTrades":
            metrics["losingTrades"],

        "winRate":
            metrics["winRate"],

        "grossProfit":
            metrics["grossProfit"],

        "grossLoss":
            metrics["grossLoss"],

        "netPnl":
            metrics["netPnl"],

        "profitFactor":
            metrics["profitFactor"],

        "maxDrawdown":
            metrics["maxDrawdown"],

    }


    # ------------------------------
    # FINAL JSON
    # ------------------------------

    return {

        "backtest": {

            "symbol": "NIFTY 50",

            "exchange": "NSE",

            "timeframe": "15m",

            "strategy":
                strategy.STRATEGY_NAME,

            "startDate":
                iso(start_date),

            "endDate":
                iso(end_date),

            "dateRange": {

                "from":
                    iso(start_date),

                "to":
                    iso(end_date),

            },

        },


        "strategy": {

            "name":
                strategy.STRATEGY_NAME,

            "description":
                "Results generated by Python backtesting engine.",

            "parameters": {

                "gapThreshold":
                    "0.30%",

                "riskReward":
                    getattr(
                        strategy,
                        "RR",
                        2.0,
                    ),

            },

        },


        "dataset": {

            "file":
                str(data_file),

            "candleCount":
                len(candles),

            "tradingDays":
                trading_days,

        },


        "candles":
            candles,

        "trades":
            trade_json,

        "metrics":
            frontend_metrics,

        "equityCurve":
            equity_curve,

    }


# --------------------------------------------------
# MAIN BACKTEST
# --------------------------------------------------

def main():

    # ------------------------------
    # CHECK COMMAND
    # ------------------------------

    if len(sys.argv) < 2:

        print()

        print(
            "Usage:"
        )

        print(
            "python run_backtest.py <strategy_name> [data_file]"
        )

        print()

        return


    # ------------------------------
    # STRATEGY NAME
    # ------------------------------

    strategy_name = sys.argv[1]


    # ------------------------------
    # DATA FILE
    # ------------------------------

    if len(sys.argv) >= 3:

        data_file = Path(
            sys.argv[2]
        )

    else:

        data_file = DEFAULT_DATA_FILE


    # ------------------------------
    # CHECK DATA FILE
    # ------------------------------

    if not data_file.exists():

        print()

        print(
            f"Data file not found: {data_file}"
        )

        print()

        return


    # ------------------------------
    # LOAD STRATEGY
    # ------------------------------

    try:

        strategy = importlib.import_module(
            f"strategies.{strategy_name}"
        )

    except ModuleNotFoundError:

        print()

        print(
            f"Strategy not found: {strategy_name}"
        )

        print()

        return


    # ------------------------------
    # LOAD OHLC DATA
    # ------------------------------

    df = load_data(
        data_file
    )

    df["date"] = (
        df["time"].dt.date
    )


    # ------------------------------
    # RUN BACKTEST
    # ------------------------------

    trades = []

    trading_days = sorted(
        df["date"].unique()
    )


    for i in range(
        1,
        len(trading_days),
    ):

        current_date = (
            trading_days[i]
        )

        previous_date = (
            trading_days[i - 1]
        )


        day_df = df[
            df["date"] == current_date
        ].copy()


        previous_day_df = df[
            df["date"] == previous_date
        ].copy()


        if (
            day_df.empty
            or previous_day_df.empty
        ):

            continue


        previous_close = float(
            previous_day_df.iloc[-1][
                "close"
            ]
        )


        # --------------------------
        # ASK STRATEGY FOR SIGNAL
        # --------------------------

        signal = strategy.check_signal(
            day_df,
            previous_close,
        )


        if signal is None:

            continue


        # --------------------------
        # EXECUTE TRADE
        # --------------------------

        trade = execute_trade(

            day_df,

            signal["signal_row"],

            rr=strategy.RR,

        )


        if trade is None:

            continue


        # --------------------------
        # ADD STRATEGY INFORMATION
        # --------------------------

        trade["Trade Date"] = (
            current_date
        )

        trade["Direction"] = "Long"

        trade["Gap %"] = (
            signal["gap_pct"]
        )

        trade["PDC"] = (
            previous_close
        )

        trade["Today Open"] = float(
            day_df.iloc[0]["open"]
        )

        trade["First Candle Time"] = (
            day_df.iloc[0]["time"]
        )

        trade["First Candle High"] = (
            signal["first_candle_high"]
        )


        trades.append(
            trade
        )


    # ------------------------------
    # CALCULATE METRICS
    # ------------------------------

    metrics = calculate_metrics(
        trades
    )


    # ------------------------------
    # BUILD FRONTEND DATA
    # ------------------------------

    frontend_data = build_frontend_data(

        df,

        trades,

        metrics,

        strategy,

        data_file,

    )


    # ------------------------------
    # WRITE LOCAL data.json
    # ------------------------------

    with open(
        "data.json",
        "w",
        encoding="utf-8",
    ) as f:

        json.dump(
            frontend_data,
            f,
            indent=2,
        )


    # ------------------------------
    # UPDATE FRONTEND data.json
    # ------------------------------

    shutil.copy2(

        "data.json",

        FRONTEND_DATA_FILE,

    )


    # ------------------------------
    # PRINT RESULTS
    # ------------------------------

    print()

    print(
        "=" * 50
    )

    print(
        strategy.STRATEGY_NAME
    )

    print(
        "=" * 50
    )

    print(
        f"Data file:     {data_file}"
    )

    print(
        f"Total trades:  {metrics['totalTrades']}"
    )

    print(
        f"Wins:          {metrics['winningTrades']}"
    )

    print(
        f"Losses:        {metrics['losingTrades']}"
    )

    print(
        f"Win rate:      {metrics['winRate']:.2f}%"
    )

    print(
        f"Gross profit:  {metrics['grossProfit']:.2f}"
    )

    print(
        f"Gross loss:    {metrics['grossLoss']:.2f}"
    )

    print(
        f"Net points:    {metrics['netPnl']:.2f}"
    )

    print(
        f"Profit factor: {metrics['profitFactor']:.4f}"
    )

    print(
        f"Max drawdown:  {metrics['maxDrawdown']:.2f}"
    )

    print()

    print(
        "data.json created."
    )

    print(
        "Dashboard data updated."
    )

    print(
        "=" * 50
    )


# --------------------------------------------------
# START PROGRAM
# --------------------------------------------------

if __name__ == "__main__":

    main()
