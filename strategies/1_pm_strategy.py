"""
1:00 PM 15-Minute CN Breakout Strategy

RULES
-----
CN is the 15-minute candle whose START timestamp is exactly 1:00 PM.

After CN is completed, subsequent 15-minute candles are checked for breakout
confirmation. The first eligible candle that closes above CN High creates a
LONG signal. The first eligible candle that closes below CN Low creates a
SHORT signal.

Entry:
    Enter at the OPEN of the 15-minute candle immediately following the
    confirmed breakout candle.

Long:
    Stop Loss = CN Low
    Risk = Entry - Stop Loss
    Target = Entry + (Risk * RR)
    Close-based exit = a 15m candle closes below CN Low

Short:
    Stop Loss = CN High
    Risk = Stop Loss - Entry
    Target = Entry - (Risk * RR)
    Close-based exit = a 15m candle closes above CN High

Time exit:
    Close any open trade at 3:10 PM, using the 5-minute timeframe.

The first valid breakout direction wins. Once a trade has been generated from
the CN setup, the opposite direction is ignored.

This file contains the strategy calculations and signal definitions. The
project's existing common execution engine should remain responsible for
actual order execution and trade management.
"""

from dataclasses import dataclass
from datetime import time
from typing import Optional


# ---------------------------------------------------------------------------
# Strategy metadata
# ---------------------------------------------------------------------------

SYMBOL = "NIFTY"
TIMEFRAME = "15m"
TIMEFRAMES = ["15m", "5m"]
STRATEGY_NAME = "1:00 PM 15m CN Breakout"

RR = 2.0

CN_START_TIME = time(13, 0)          # 1:00 PM
BREAKOUT_START_TIME = time(13, 15)   # first candle after CN
BREAKOUT_CUTOFF_TIME = time(14, 15)  # 2:15 PM
TIME_EXIT_TIME = time(15, 10)        # 3:10 PM


@dataclass
class CNLevels:
    """Reference levels from the 1:00 PM 15-minute CN candle."""
    high: float
    low: float
    timestamp: object


@dataclass
class TradeSetup:
    """Confirmed setup before execution at the next 15m candle open."""
    direction: str
    breakout_timestamp: object
    entry_timestamp: object
    cn_high: float
    cn_low: float


def is_cn_candle(timestamp) -> bool:
    """
    Return True only for the 15-minute candle whose start timestamp is 1:00 PM.
    """
    return timestamp.time() == CN_START_TIME


def is_eligible_breakout_candle(timestamp) -> bool:
    """
    Return True when the completed 15m candle is eligible to confirm a
    breakout.

    The 1:15 candle is the first candidate.

    The <= comparison means the candle closing at exactly 2:15 PM is included.
    If the intended rule is strictly BEFORE 2:15 PM, change <= to <.
    """
    t = timestamp.time()
    return BREAKOUT_START_TIME <= t <= BREAKOUT_CUTOFF_TIME


def build_cn_levels(cn_candle) -> CNLevels:
    """Create CN reference levels from the completed 1:00 PM candle."""
    return CNLevels(
        high=float(cn_candle["high"]),
        low=float(cn_candle["low"]),
        timestamp=cn_candle.name,
    )


def long_breakout(cn_high: float, candle_close: float) -> bool:
    """Long breakout requires a close strictly above CN High."""
    return candle_close > cn_high


def short_breakout(cn_low: float, candle_close: float) -> bool:
    """Short breakout requires a close strictly below CN Low."""
    return candle_close < cn_low


def detect_breakout(cn: CNLevels, candle) -> Optional[str]:
    """
    Evaluate one COMPLETED 15m candle.

    Returns:
        "LONG"  - close > CN High
        "SHORT" - close < CN Low
        None    - no breakout / candle not eligible
    """
    timestamp = candle["time"]

    if not is_eligible_breakout_candle(timestamp):
        return None

    close = float(candle["close"])

    if long_breakout(cn.high, close):
        return "LONG"

    if short_breakout(cn.low, close):
        return "SHORT"

    return None


def make_trade_setup(
    direction: str,
    breakout_candle,
    next_candle,
    cn: CNLevels,
) -> TradeSetup:
    """
    Create a confirmed setup.

    IMPORTANT:
    The breakout candle must already be COMPLETED before this function is
    called. Entry is the next 15m candle OPEN.
    """
    return TradeSetup(
        direction=direction,
        breakout_timestamp=breakout_candle.name,
        entry_timestamp=next_candle.name,
        cn_high=cn.high,
        cn_low=cn.low,
    )


def calculate_long_trade(entry_price: float, cn_low: float) -> Optional[dict]:
    """
    Long:
        SL = CN Low
        Risk = Entry - SL
        TP = Entry + Risk * RR
    """
    stop_loss = cn_low
    risk = entry_price - stop_loss

    if risk <= 0:
        return None

    return {
        "side": "LONG",
        "entry": entry_price,
        "stop_loss": stop_loss,
        "risk": risk,
        "target": entry_price + (risk * RR),
    }


def calculate_short_trade(entry_price: float, cn_high: float) -> Optional[dict]:
    """
    Short:
        SL = CN High
        Risk = SL - Entry
        TP = Entry - Risk * RR
    """
    stop_loss = cn_high
    risk = stop_loss - entry_price

    if risk <= 0:
        return None

    return {
        "side": "SHORT",
        "entry": entry_price,
        "stop_loss": stop_loss,
        "risk": risk,
        "target": entry_price - (risk * RR),
    }


def close_based_exit(
    side: str,
    candle_close: float,
    cn_high: float,
    cn_low: float,
) -> bool:
    """
    CN-boundary close exit.

    LONG:
        candle close < CN Low

    SHORT:
        candle close > CN High

    This is deliberately based on CLOSE, not merely an intrabar touch.
    """
    if side == "LONG":
        return candle_close < cn_low

    if side == "SHORT":
        return candle_close > cn_high

    return False


def is_time_exit(timestamp) -> bool:
    """
    True at the 5-minute candle timestamp used for the 3:10 PM time exit.
    """
    return timestamp.time() == TIME_EXIT_TIME


# ---------------------------------------------------------------------------
# BACKTEST RUNNER INTERFACE
# ---------------------------------------------------------------------------

SUPPORTS_DIRECTIONS = True


def check_signal(
    day_df,
    previous_close=None,
    data_manager=None,
    datasets=None,
):
    """
    Runner interface for the 1 PM CN breakout strategy.

    Only completed 15m candles are considered. The first eligible breakout
    after the completed 1:00 PM CN candle wins.
    """

    cn_rows = day_df[
        day_df["time"].dt.time == CN_START_TIME
    ]

    if cn_rows.empty:
        return None

    cn_candle = cn_rows.iloc[0]

    cn = CNLevels(
        high=float(cn_candle["high"]),
        low=float(cn_candle["low"]),
        timestamp=cn_candle["time"],
    )

    # Search in chronological order. The first valid direction wins.
    candidates = day_df[
        (day_df["time"].dt.time >= BREAKOUT_START_TIME)
        & (day_df["time"].dt.time <= BREAKOUT_CUTOFF_TIME)
    ].sort_values("time")

    for idx, candle in candidates.iterrows():
        direction = detect_breakout(cn, candle)

        if direction is None:
            continue

        # Entry must be the immediately following 15m candle.
        later = day_df[day_df.index > idx]

        if later.empty:
            return None

        next_candle = later.iloc[0]

        if direction == "LONG":
            stop_loss = cn.low
        else:
            stop_loss = cn.high

        return {
            "direction": direction,
            "signal_row": candle,
            "entry_row": next_candle,
            "stop_loss": stop_loss,
            "cn_high": cn.high,
            "cn_low": cn.low,
        }

    return None
