"""
Strategy 1: Gap Up + First-15-Minute Breakout
"""

GAP_THRESHOLD_PCT = 0.30
RR = 2.0

SYMBOL = "NIFTY"
TIMEFRAME = "15m"

# Timeframes this strategy may use.
# Currently Strategy #1 only uses 15m.
TIMEFRAMES = ["15m"]

STRATEGY_NAME = "Gap Up + Range Breakout"


def check_signal(
    day_df,
    previous_close,
    data_manager=None,
    datasets=None,
):
    """
    Find the first valid breakout signal for the day.

    Rules:
    - Gap >= 0.30%
    - First 15-minute candle is the 09:15 candle
    - Breakout level = first candle high
    - Check candles from 09:30 through 11:00
    - Signal = first candle closing above first candle high
    """

    today_open = float(day_df.iloc[0]["open"])

    gap_pct = (today_open - previous_close) / previous_close * 100

    if gap_pct < GAP_THRESHOLD_PCT:
        return None

    first_candle = day_df.iloc[0]
    first_candle_high = float(first_candle["high"])

    signal_row = None

    for _, row in day_df.iterrows():
        time_value = row["time"]

        if time_value.hour == 9 and time_value.minute == 15:
            continue

        if time_value.hour < 9 or time_value.hour > 11:
            continue

        if time_value.hour == 9 and time_value.minute < 30:
            continue

        if time_value.hour == 11 and time_value.minute > 0:
            continue

        if float(row["close"]) > first_candle_high:
            signal_row = row
            break

    if signal_row is None:
        return None

    return {
        "gap_pct": gap_pct,
        "first_candle_high": first_candle_high,
        "signal_row": signal_row,
    }

