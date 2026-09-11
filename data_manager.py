"""
Data Manager
============

Master data source:
    1-minute OHLC

Supported timeframes:
    1m
    5m
    15m
    30m
    1h
    1d

All higher timeframes are generated from the 1-minute master data.
"""

from pathlib import Path
import pandas as pd


class DataManager:

    def __init__(self, data_directory="data"):

        self.data_directory = Path(
            data_directory
        )

        self._cache = {}


    # ---------------------------------------------------------
    # FIND DATA FILE
    # ---------------------------------------------------------

    def find_file(self, symbol):

        symbol_upper = symbol.upper()

        files = list(
            self.data_directory.glob("*.xlsx")
        )

        candidates = []

        for file in files:

            name = file.name.upper()

            if "1MIN" not in name:
                continue

            if symbol_upper == "NIFTY":

                if (
                    "NIFTY 50" in name
                    or "NIFTY" in name
                ):
                    candidates.append(file)

            elif symbol_upper in name:

                candidates.append(file)


        if not candidates:

            raise FileNotFoundError(
                f"No 1-minute Excel file found "
                f"for symbol: {symbol}"
            )


        candidates.sort(
            key=lambda x: x.stat().st_size,
            reverse=True
        )

        return candidates[0]


    # ---------------------------------------------------------
    # LOAD 1-MINUTE DATA
    # ---------------------------------------------------------

    def load_1min(self, symbol):

        cache_key = (
            symbol.upper(),
            "1m"
        )

        if cache_key in self._cache:

            return self._cache[
                cache_key
            ].copy()


        file_path = self.find_file(
            symbol
        )


        excel = pd.ExcelFile(
            file_path
        )


        preferred_sheet = (
            "OHLC-1min-Data"
        )


        if preferred_sheet in excel.sheet_names:

            sheet_name = preferred_sheet

        else:

            sheet_name = (
                excel.sheet_names[0]
            )


        df = pd.read_excel(
            file_path,
            sheet_name=sheet_name
        )


        df.columns = [

            str(column)
            .strip()
            .lower()

            for column in df.columns

        ]


        required_columns = [

            "time",
            "open",
            "high",
            "low",
            "close",

        ]


        missing = [

            column

            for column in required_columns

            if column not in df.columns

        ]


        if missing:

            raise ValueError(

                f"Missing required columns: "
                f"{missing}"

            )


        df["time"] = pd.to_datetime(

            df["time"],

            format="%d %b %y %I:%M %p",

            errors="coerce"

        )


        if df["time"].isna().any():

            df["time"] = pd.to_datetime(

                df["time"],

                errors="coerce"

            )


        for column in [

            "open",
            "high",
            "low",
            "close",

        ]:

            df[column] = (

                df[column]

                .astype(str)

                .str.replace(
                    ",",
                    "",
                    regex=False
                )

                .str.strip()

            )


            df[column] = pd.to_numeric(

                df[column],

                errors="coerce"

            )


        df = df.dropna(

            subset=[

                "time",
                "open",
                "high",
                "low",
                "close",

            ]

        )


        df = (

            df

            .sort_values("time")

            .drop_duplicates(
                subset=["time"]
            )

            .reset_index(
                drop=True
            )

        )


        df["date"] = (
            df["time"].dt.date
        )


        self._cache[
            cache_key
        ] = df.copy()


        return df.copy()


    # ---------------------------------------------------------
    # RESAMPLE ONE TRADING DAY
    # ---------------------------------------------------------

    @staticmethod
    def _resample_intraday(
        day_df,
        rule
    ):

        data = day_df.copy()

        data = data.set_index(
            "time"
        )


        result = data.resample(

            rule,

            origin="start_day",

            offset="15min",

            label="left",

            closed="left"

        ).agg(

            {

                "open": "first",

                "high": "max",

                "low": "min",

                "close": "last",

            }

        )


        result = result.dropna(

            subset=[

                "open",
                "high",
                "low",
                "close",

            ]

        )


        result = result.reset_index()


        return result


    # ---------------------------------------------------------
    # BUILD INTRADAY TIMEFRAME
    # ---------------------------------------------------------

    def _build_intraday(
        self,
        df,
        rule
    ):

        pieces = []


        for _, day_df in df.groupby(
            "date"
        ):

            day_df = day_df.copy()


            result = self._resample_intraday(

                day_df,

                rule

            )


            if not result.empty:

                pieces.append(
                    result
                )


        if not pieces:

            return pd.DataFrame(

                columns=[

                    "time",
                    "open",
                    "high",
                    "low",
                    "close",
                    "date",

                ]

            )


        result = pd.concat(

            pieces,

            ignore_index=True

        )


        result["date"] = (
            result["time"].dt.date
        )


        return (

            result

            .sort_values("time")

            .reset_index(
                drop=True
            )

        )


    # ---------------------------------------------------------
    # BUILD DAILY DATA
    # ---------------------------------------------------------

    @staticmethod
    def _build_daily(df):

        result = (

            df

            .groupby(
                "date",
                sort=True
            )

            .agg(

                {

                    "open": "first",

                    "high": "max",

                    "low": "min",

                    "close": "last",

                }

            )

            .reset_index()

        )


        result["time"] = pd.to_datetime(

            result["date"].astype(str)
            + " 09:15:00"

        )


        result = result[

            [

                "time",
                "open",
                "high",
                "low",
                "close",
                "date",

            ]

        ]


        return result.reset_index(
            drop=True
        )

        # ---------------------------------------------------------
    # GET LAST COMPLETED HIGHER-TIMEFRAME CANDLE
    # ---------------------------------------------------------

    def get_completed_candle(
        self,
        symbol,
        timeframe,
        timestamp
    ):
        """
        Return the most recent COMPLETED candle available
        at the supplied timestamp.

        Look-ahead protection:

        15m example:
            At 10:05 -> latest completed candle = 09:45
            At 10:15 -> latest completed candle = 10:00
            At 10:20 -> latest completed candle = 10:00
            At 10:30 -> latest completed candle = 10:15
        """

        data = self.get(
            symbol,
            timeframe
        )

        timestamp = pd.Timestamp(timestamp)

        # -----------------------------------------------------
        # Intraday timeframe durations
        # -----------------------------------------------------

        durations = {
            "1m": pd.Timedelta(minutes=1),
            "5m": pd.Timedelta(minutes=5),
            "15m": pd.Timedelta(minutes=15),
            "30m": pd.Timedelta(minutes=30),
            "1h": pd.Timedelta(hours=1),
        }

        if timeframe in durations:

            candle_completion_time = (
                data["time"] + durations[timeframe]
            )

            completed = data[
                candle_completion_time <= timestamp
            ]

            if completed.empty:
                return None

            return completed.iloc[-1].copy()

        # -----------------------------------------------------
        # Daily timeframe
        # -----------------------------------------------------

        if timeframe.lower() == "1d":

            # A daily candle is completed after the final
            # intraday candle of that trading day.
            base = self.load_1min(symbol).copy()

            base["date"] = base["time"].dt.date

            daily_completion = (
                base.groupby("date")["time"]
                .max()
                .reset_index()
            )

            daily_completion["completion_time"] = (
                daily_completion["time"]
                + pd.Timedelta(minutes=1)
            )

            daily_data = data.copy()
            daily_data["date"] = daily_data["time"].dt.date

            daily_data = daily_data.merge(
                daily_completion[
                    ["date", "completion_time"]
                ],
                on="date",
                how="left"
            )

            completed = daily_data[
                daily_data["completion_time"] <= timestamp
            ]

            if completed.empty:
                return None

            return completed.iloc[-1].drop(
                labels=["date", "completion_time"]
            )

        raise ValueError(
            f"Unsupported timeframe: {timeframe}"
        )
    # ---------------------------------------------------------
    # GET MULTIPLE TIMEFRAMES
    # ---------------------------------------------------------

    def get_multiple(
        self,
        symbol,
        timeframes
    ):

        """
        Return multiple timeframes
        for the same symbol.

        Example:

            data = manager.get_multiple(
                "NIFTY",
                [
                    "1d",
                    "1h",
                    "15m",
                    "5m",
                    "1m"
                ]
            )

        Result:

            {
                "1d": daily_data,
                "1h": hourly_data,
                "15m": fifteen_min_data,
                "5m": five_min_data,
                "1m": one_min_data,
            }
        """

        result = {}


        for timeframe in timeframes:

            result[timeframe] = self.get(

                symbol,

                timeframe

            )


        return result


    # ---------------------------------------------------------
    # PUBLIC GET METHOD
    # ---------------------------------------------------------

    def get(
        self,
        symbol,
        timeframe
    ):

        symbol = symbol.upper()

        timeframe = timeframe.lower()


        cache_key = (
            symbol,
            timeframe
        )


        if cache_key in self._cache:

            return self._cache[
                cache_key
            ].copy()


        base = self.load_1min(
            symbol
        )


        if timeframe == "1m":

            result = base


        elif timeframe == "5m":

            result = self._build_intraday(

                base,

                "5min"

            )


        elif timeframe == "15m":

            result = self._build_intraday(

                base,

                "15min"

            )


        elif timeframe == "30m":

            result = self._build_intraday(

                base,

                "30min"

            )


        elif timeframe == "1h":

            result = self._build_intraday(

                base,

                "1h"

            )


        elif timeframe == "1d":

            result = self._build_daily(
                base
            )


        else:

            raise ValueError(

                "Unsupported timeframe. "

                "Use: 1m, 5m, 15m, "
                "30m, 1h, or 1d."

            )


        self._cache[
            cache_key
        ] = result.copy()


        return result.copy()


# -------------------------------------------------------------
# TEST
# -------------------------------------------------------------

if __name__ == "__main__":

    manager = DataManager()


    print()

    print(
        "Data Manager Test"
    )

    print(
        "================="
    )


    for timeframe in [

        "1m",
        "5m",
        "15m",
        "30m",
        "1h",
        "1d",

    ]:

        data = manager.get(

            "NIFTY",

            timeframe

        )


        print(

            f"{timeframe:>4} : "

            f"{len(data):>6} candles | "

            f"{data['time'].min()} → "

            f"{data['time'].max()}"

        )


    print()

    print(
        "Multi-timeframe test"
    )

    print(
        "--------------------"
    )


    multiple = manager.get_multiple(

        "NIFTY",

        [

            "1d",
            "1h",
            "15m",
            "5m",
            "1m",

        ]

    )


    for timeframe, data in multiple.items():

        print(

            f"{timeframe:>4} : "
            f"{len(data):>6} candles"

        )


    print()

    print(
        "Data Manager test completed."
    )
