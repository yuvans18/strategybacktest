"""
Reusable NIFTY 15-minute Gap-Up + First-15-Minute Breakout backtester.

Confirmed rules:
- PDC = previous trading day's close.
- Gap% = (today 09:15 open - PDC) / PDC * 100.
- Trade only if Gap% >= 0.30%.
- First candle is 09:15 (the first 15-minute candle).
- From 09:30 through 11:00 inclusive, find the FIRST candle with Close > FirstCandleHigh.
- Enter LONG at the OPEN of the immediately following candle.
- SL = LOW of the signal/breakout candle (Cn).
- Risk = Entry - SL.
- Target = Entry + 2*Risk.
- Target is completed if any post-entry candle HIGH >= Target.
- SL is completed only if a post-entry candle CLOSE <= SL.
- If target and SL conditions occur on the same candle, target wins.
- If neither is reached, exit at the final available candle CLOSE for that day.
- One trade maximum per day.
- Entry candle timestamp is explicitly recorded.
"""

import pandas as pd

INPUT_FILE = "Nifty 50-OHLC-15min-Data-14Oct2025(2.15PM)-9Sep2026(3.15PM).xlsx"
OUTPUT_TRADES = "trade_log.xlsx"
OUTPUT_SUMMARY = "backtest_summary.xlsx"

GAP_THRESHOLD_PCT = 0.30
RR = 2.0

def load_data(path):
    df = pd.read_excel(path, sheet_name=0)

    df["time"] = pd.to_datetime(df["time"], errors="coerce")
    for col in ["open", "high", "low", "close"]:
        df[col] = pd.to_numeric(
            df[col].astype(str).str.replace(",", "", regex=False),
            errors="coerce"
        )

    df = df.dropna(subset=["time", "open", "high", "low", "close"]).copy()
    df = df.sort_values("time").reset_index(drop=True)
    df["trade_date"] = df["time"].dt.date
    df["clock"] = df["time"].dt.strftime("%H:%M")
    return df

def backtest(df):
    daily_close = df.groupby("trade_date")["close"].last()
    dates = list(daily_close.index)
    trades = []

    for i, day in enumerate(dates):
        if i == 0:
            continue

        pdc = float(daily_close.loc[dates[i - 1]])
        day_df = df[df["trade_date"] == day].copy()

        first = day_df[day_df["clock"] == "09:15"]
        if first.empty:
            continue

        first_row = first.iloc[0]
        today_open = float(first_row["open"])
        first_high = float(first_row["high"])

        gap_pct = (today_open - pdc) / pdc * 100
        if gap_pct < GAP_THRESHOLD_PCT:
            continue

        # Search 09:30 through 11:00 inclusive.
        candidates = day_df[
            (day_df["clock"] >= "09:30") &
            (day_df["clock"] <= "11:00")
        ]

        signal_row = None
        for _, row in candidates.iterrows():
            if float(row["close"]) > first_high:
                signal_row = row
                break

        if signal_row is None:
            continue

        # The entry is the next candle after Cn.
        after_signal = day_df[day_df.index > signal_row.name]
        if after_signal.empty:
            continue

        entry_row = after_signal.iloc[0]
        entry = float(entry_row["open"])
        sl = float(signal_row["low"])
        risk = entry - sl

        if risk <= 0:
            continue

        target = entry + RR * risk

        post_entry = day_df[day_df.index >= entry_row.name]
        exit_price = None
        exit_time = None
        exit_reason = None

        for _, row in post_entry.iterrows():
            high = float(row["high"])
            close = float(row["close"])

            target_hit = high >= target
            sl_hit = close <= sl

            # Confirmed rule: target touch wins if both conditions happen
            # on the same 15-minute candle.
            if target_hit:
                exit_price = target
                exit_time = row["time"]
                exit_reason = "TARGET"
                break

            if sl_hit:
                exit_price = close
                exit_time = row["time"]
                exit_reason = "STOP_CLOSE"
                break

        if exit_price is None:
            last = day_df.iloc[-1]
            exit_price = float(last["close"])
            exit_time = last["time"]
            exit_reason = "EOD"

        points = exit_price - entry

        trades.append({
            "Trade No": len(trades) + 1,
            "Trade Date": day,
            "Direction": "LONG",
            "Gap %": gap_pct,
            "PDC": pdc,
            "Today Open": today_open,
            "First Candle Time": first_row["time"],
            "First Candle High": first_high,
            "Signal Candle Time (Cn)": signal_row["time"],
            "Signal Candle Close": float(signal_row["close"]),
            "Signal Candle Low (SL)": sl,
            "Entry Candle Time (Cn+1)": entry_row["time"],
            "Entry": entry,
            "Stop Loss": sl,
            "Risk": risk,
            "RR": RR,
            "Target": target,
            "Exit Time": exit_time,
            "Exit Price": exit_price,
            "Exit Reason": exit_reason,
            "Result": "WIN" if points > 0 else ("LOSS" if points < 0 else "BREAKEVEN"),
            "Points": points,
            "Points Won": max(points, 0),
            "Points Lost": max(-points, 0),
        })

    return pd.DataFrame(trades)

def make_summary(trades):
    if trades.empty:
        return pd.DataFrame({"Metric": ["Total Trades"], "Value": [0]})

    total = len(trades)
    wins = int((trades["Points"] > 0).sum())
    losses = int((trades["Points"] < 0).sum())
    be = int((trades["Points"] == 0).sum())
    won = float(trades.loc[trades["Points"] > 0, "Points"].sum())
    lost = float(trades.loc[trades["Points"] < 0, "Points"].sum())
    net = float(trades["Points"].sum())

    equity = trades["Points"].cumsum()
    drawdown = equity - equity.cummax()

    summary = [
        ("Total Trades", total),
        ("Long Trades", total),
        ("Short Trades", 0),
        ("Winning Trades", wins),
        ("Losing Trades", losses),
        ("Breakeven Trades", be),
        ("Win Rate %", wins / total * 100),
        ("Total Points Won", won),
        ("Total Points Lost", abs(lost)),
        ("Net Points", net),
        ("Average Points / Trade", net / total),
        ("Average Winning Trade", won / wins if wins else 0),
        ("Average Losing Trade", abs(lost) / losses if losses else 0),
        ("Profit Factor", won / abs(lost) if lost else float("inf")),
        ("Maximum Drawdown (points)", float(drawdown.min())),
        ("Largest Winning Trade", float(trades["Points"].max())),
        ("Largest Losing Trade", float(trades["Points"].min())),
    ]
    return pd.DataFrame(summary, columns=["Metric", "Value"])

if __name__ == "__main__":
    data = load_data(INPUT_FILE)
    trades = backtest(data)
    summary = make_summary(trades)

    trades.to_excel(OUTPUT_TRADES, index=False)
    summary.to_excel(OUTPUT_SUMMARY, index=False)

    print(summary.to_string(index=False))
    print(f"Saved {OUTPUT_TRADES}")
    print(f"Saved {OUTPUT_SUMMARY}")
