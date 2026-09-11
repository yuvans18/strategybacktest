"""
Common backtesting engine.

Existing long-only strategies remain supported.
New directional strategies can use LONG/SHORT execution and a lower-timeframe
time exit without changing the original strategy behaviour.
"""

import pandas as pd


def load_data(path):
    df = pd.read_excel(path, sheet_name="OHLC-15min-Data")
    df["time"] = pd.to_datetime(df["time"], format="%d %b %y %I:%M %p")

    for column in ["open", "high", "low", "close"]:
        df[column] = (
            df[column].astype(str)
            .str.replace(",", "", regex=False)
            .astype(float)
        )

    return df.sort_values("time").reset_index(drop=True)


def execute_trade(
    day_df,
    signal_row,
    rr=2.0,
    direction="LONG",
    stop_loss=None,
    time_exit_df=None,
    time_exit_time=None,
):
    """
    Common trade execution.

    Legacy mode (the existing gap_breakout strategy) is unchanged:
      LONG, SL from signal candle low, EOD at final 15m close.

    Directional mode:
      - LONG or SHORT
      - explicit stop_loss can be supplied by strategy
      - target is touch based
      - LONG stop = 15m close <= SL
      - SHORT stop = 15m close >= SL
      - optional time exit uses the OPEN of the 5m candle at time_exit_time
    """

    direction = str(direction).upper()
    if direction not in ("LONG", "SHORT"):
        return None

    after_signal = day_df[day_df.index > signal_row.name]
    if after_signal.empty:
        return None

    entry_row = after_signal.iloc[0]
    entry = float(entry_row["open"])

    if stop_loss is None:
        sl = float(signal_row["low"]) if direction == "LONG" else float(signal_row["high"])
    else:
        sl = float(stop_loss)

    if direction == "LONG":
        risk = entry - sl
        target = entry + rr * risk
    else:
        risk = sl - entry
        target = entry - rr * risk

    if risk <= 0:
        return None

    post_entry = day_df[day_df.index >= entry_row.name]

    exit_price = None
    exit_time = None
    exit_reason = None

    # ------------------------------------------------------------
    # No lower-timeframe time exit: original execution behaviour.
    # ------------------------------------------------------------
    if time_exit_df is None or time_exit_time is None:
        for _, row in post_entry.iterrows():
            high = float(row["high"])
            low = float(row["low"])
            close = float(row["close"])

            if direction == "LONG":
                target_hit = high >= target
                stop_hit = close <= sl
            else:
                target_hit = low <= target
                stop_hit = close >= sl

            if target_hit:
                exit_price = target
                exit_time = row["time"]
                exit_reason = "Target"
                break

            if stop_hit:
                exit_price = close
                exit_time = row["time"]
                exit_reason = "Stop Loss"
                break

    # ------------------------------------------------------------
    # Time-exit mode.
    #
    # We process normal 15m target/stop conditions until the last
    # completed 15m candle BEFORE the 15:00-15:15 candle.
    #
    # The 15:00 15m candle is special: its close occurs after 15:10,
    # so its 15m close cannot be used as a stop before the time exit.
    # Its 5m candles at 15:00 and 15:05 can still establish a target
    # touch before 15:10.
    # ------------------------------------------------------------
    else:
        time_rows = time_exit_df[
            time_exit_df["time"].dt.time == time_exit_time
        ]

        time_rows = time_rows[
            time_rows["time"] >= entry_row["time"]
        ]

        if time_rows.empty:
            # Fall back to normal EOD handling if requested 5m time
            # candle is unavailable.
            time_rows = None

        exit_time_timestamp = (
            time_rows.iloc[0]["time"] if time_rows is not None else None
        )

        for _, row in post_entry.iterrows():
            candle_start = row["time"]

            # Once the 15m candle reaches/passes the exact time exit,
            # do not use its future high/low/close.
            if (
                exit_time_timestamp is not None
                and candle_start >= exit_time_timestamp
            ):
                break

            # If this 15m candle crosses the exact time exit, use
            # lower-timeframe data before the exit time.
            if (
                exit_time_timestamp is not None
                and candle_start < exit_time_timestamp
                and candle_start + pd.Timedelta(minutes=15) > exit_time_timestamp
            ):
                five_min = time_exit_df[
                    (time_exit_df["time"] >= candle_start)
                    & (time_exit_df["time"] < exit_time_timestamp)
                    & (time_exit_df["time"] >= entry_row["time"])
                ]

                for _, five in five_min.iterrows():
                    high = float(five["high"])
                    low = float(five["low"])

                    if direction == "LONG" and high >= target:
                        exit_price = target
                        exit_time = five["time"]
                        exit_reason = "Target"
                        break

                    if direction == "SHORT" and low <= target:
                        exit_price = target
                        exit_time = five["time"]
                        exit_reason = "Target"
                        break

                if exit_price is not None:
                    break

                # Do not use the 15m candle close because it occurs
                # after the exact time exit.
                continue

            # Normal completed 15m candle before the time-exit window.
            high = float(row["high"])
            low = float(row["low"])
            close = float(row["close"])

            if direction == "LONG":
                target_hit = high >= target
                stop_hit = close <= sl
            else:
                target_hit = low <= target
                stop_hit = close >= sl

            if target_hit:
                exit_price = target
                exit_time = row["time"]
                exit_reason = "Target"
                break

            if stop_hit:
                exit_price = close
                exit_time = row["time"]
                exit_reason = "Stop Loss"
                break

               # ------------------------------------------------------------
        # TIME EXIT
        #
        # 15:10 5m candle CLOSE confirms the time exit.
        # Actual exit happens at the NEXT 5m candle OPEN (15:15).
        # ------------------------------------------------------------
        if exit_price is None and exit_time_timestamp is not None:

            next_time_rows = time_exit_df[
                time_exit_df["time"] > exit_time_timestamp
            ]

            if not next_time_rows.empty:
                next_time_row = next_time_rows.iloc[0]

                exit_price = float(next_time_row["open"])
                exit_time = next_time_row["time"]
                exit_reason = "Time Exit"

    # ------------------------------------------------------------
    # Final fallback.
    # ------------------------------------------------------------
    if exit_price is None:
        final_row = post_entry.iloc[-1]
        exit_price = float(final_row["close"])
        exit_time = final_row["time"]
        exit_reason = "EOD"

    if direction == "LONG":
        points = exit_price - entry
    else:
        points = entry - exit_price

    return {
        "Signal Candle Time (Cn)": signal_row["time"],
        "Signal Candle Close": float(signal_row["close"]),
        "Signal Candle Low (SL)": float(signal_row["low"]),
        "Signal Candle High (SL)": float(signal_row["high"]),
        "Entry Candle Time (Cn+1)": entry_row["time"],
        "Entry": entry,
        "Stop Loss": sl,
        "Risk": risk,
        "RR": rr,
        "Target": target,
        "Exit Time": exit_time,
        "Exit Price": exit_price,
        "Exit Reason": exit_reason,
        "Direction": direction.title(),
        "Points": points,
        "Points Won": max(points, 0),
        "Points Lost": max(-points, 0),
    }


def calculate_metrics(trades):
    if not trades:
        return {
            "totalTrades": 0,
            "winningTrades": 0,
            "losingTrades": 0,
            "winRate": 0,
            "grossProfit": 0,
            "grossLoss": 0,
            "netPnl": 0,
            "profitFactor": 0,
            "maxDrawdown": 0,
        }

    points = [float(t["Points"]) for t in trades]
    winning_trades = [p for p in points if p > 0]
    losing_trades = [p for p in points if p < 0]

    gross_profit = sum(winning_trades)
    gross_loss = abs(sum(losing_trades))
    net_pnl = sum(points)

    win_rate = len(winning_trades) / len(points) * 100 if points else 0
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else 0

    equity = 0
    peak = 0
    max_drawdown = 0

    for p in points:
        equity += p
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, peak - equity)

    return {
        "totalTrades": len(points),
        "winningTrades": len(winning_trades),
        "losingTrades": len(losing_trades),
        "winRate": win_rate,
        "grossProfit": gross_profit,
        "grossLoss": gross_loss,
        "netPnl": net_pnl,
        "profitFactor": profit_factor,
        "maxDrawdown": max_drawdown,
    }
