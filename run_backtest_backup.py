import importlib
import sys
from pathlib import Path

from backtester_engine import load_data, execute_trade, calculate_metrics


DATA_FILE = Path(
    "Nifty 50-OHLC-15min-Data-14Oct2025(2.15PM)-9Sep2026(3.15PM).xlsx"
)


def main():

    if len(sys.argv) < 2:
        print("Usage:")
        print("python run_backtest.py <strategy_name>")
        return

    strategy_name = sys.argv[1]

    try:
        strategy = importlib.import_module(
            f"strategies.{strategy_name}"
        )
    except ModuleNotFoundError:
        print(f"Strategy not found: {strategy_name}")
        return

    df = load_data(DATA_FILE)
    df["date"] = df["time"].dt.date

    trades = []

    trading_days = sorted(df["date"].unique())

    for i in range(1, len(trading_days)):

        current_date = trading_days[i]
        previous_date = trading_days[i - 1]

        day_df = df[df["date"] == current_date].copy()
        previous_day_df = df[df["date"] == previous_date].copy()

        if day_df.empty or previous_day_df.empty:
            continue

        previous_close = float(
            previous_day_df.iloc[-1]["close"]
        )

        signal = strategy.check_signal(
            day_df,
            previous_close
        )

        if signal is None:
            continue

        trade = execute_trade(
            day_df,
            signal["signal_row"],
            rr=strategy.RR
        )

        if trade is None:
            continue

        trade["Trade Date"] = current_date
        trade["Direction"] = "Long"
        trade["Gap %"] = signal["gap_pct"]
        trade["PDC"] = previous_close
        trade["Today Open"] = float(day_df.iloc[0]["open"])
        trade["First Candle Time"] = day_df.iloc[0]["time"]
        trade["First Candle High"] = signal["first_candle_high"]

        trades.append(trade)

    metrics = calculate_metrics(trades)

    print()
    print("=" * 50)
    print(strategy.STRATEGY_NAME)
    print("=" * 50)

    print(f"Total trades: {metrics['totalTrades']}")
    print(f"Wins:         {metrics['winningTrades']}")
    print(f"Losses:       {metrics['losingTrades']}")
    print(f"Win rate:     {metrics['winRate']:.2f}%")
    print(f"Gross profit: {metrics['grossProfit']:.2f}")
    print(f"Gross loss:   {metrics['grossLoss']:.2f}")
    print(f"Net points:   {metrics['netPnl']:.2f}")
    print(f"Profit factor: {metrics['profitFactor']:.4f}")
    print(f"Max drawdown: {metrics['maxDrawdown']:.2f}")

    print("=" * 50)


if __name__ == "__main__":
    main()
