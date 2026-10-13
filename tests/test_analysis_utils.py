"""
数值分析工具单元测试
==========================
覆盖 src/analysis_utils.py。这个模块以前**零测试**，而它的输出（统计量、趋势、
异常片段）是直接进界面的：趋势那条线的不对、异常那几条的序号对不上片段，
用户在图上是看得见的。

这里钉三件事：
1. 短序列（片段不足）与正常路径返回的**键完全一致**——这是第五十二批修的，
   原先两支各返回一套键，读 `trend["turningPoints"]` 的人只会在短书上拿到 KeyError；
2. 纯数值行为：单调序列的方向与强度、常数序列不炸、非数值一律丢掉；
3. 异常检测的两种口径（z 分数 / 四分位距）和 `counts.total` 的口径。

运行方式：
    python tests/test_analysis_utils.py
或：
    python -m unittest discover -s tests -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.analysis_utils import (  # noqa: E402
    analyze_series,
    detect_anomalies,
    linear_trend,
    summarize,
)


class TestSummarize(unittest.TestCase):
    def test_empty_returns_none_not_zero(self):
        """样本为空时字段是 None（不是编一个 0 出来）——界面据这个说「没有数据」。"""
        result = summarize([])
        self.assertEqual(result["count"], 0)
        for key in ("mean", "median", "std", "min", "max", "cv"):
            self.assertIsNone(result[key], key)

    def test_odd_and_even_median(self):
        self.assertEqual(summarize([1, 2, 3])["median"], 2.0)
        self.assertEqual(summarize([1, 2, 3, 4])["median"], 2.5)

    def test_non_numeric_values_dropped(self):
        result = summarize([1, "x", None, 3, float("nan")])
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["mean"], 2.0)

    def test_constant_series_cv_is_zero(self):
        """常数序列的变异系数是 0（完全没有相对波动），不是一个编出来的数。"""
        self.assertEqual(summarize([5.0, 5.0, 5.0])["cv"], 0.0)

    def test_zero_mean_cv_is_none(self):
        """均值为 0 时变异系数才真的无定义（要除以 0），给 None 而不是 inf。"""
        self.assertIsNone(summarize([-1.0, 1.0])["cv"])


class TestLinearTrend(unittest.TestCase):
    def test_short_series_has_same_keys_as_normal(self):
        """片段不足 3 个时，键必须和正常路径一模一样（第五十二批）。

        原来这一支只返回 4 个键（少 slopePercent 与 turningPoints），
        正常路径返回 6 个。今天没有消费者所以谁也看不见，
        但下一个读 trend["turningPoints"] 的人会拿到 KeyError。
        """
        normal_keys = set(linear_trend([1.0, 2.0, 4.0, 8.0, 16.0]))
        for values in ([], [1.0], [1.0, 2.0]):
            short = linear_trend(values)
            self.assertEqual(set(short), normal_keys, f"values={values}")
            self.assertEqual(short["direction"], "unknown")
            self.assertIsNone(short["slope"])
            self.assertIsNone(short["turningPoints"])

    def test_upward_series(self):
        trend = linear_trend([1.0, 2.0, 3.0, 4.0, 5.0])
        self.assertEqual(trend["direction"], "up")
        self.assertGreater(trend["slope"], 0)
        self.assertAlmostEqual(trend["strength"], 1.0)
        self.assertGreater(trend["slopePercent"], 0)

    def test_downward_series(self):
        trend = linear_trend([5.0, 4.0, 3.0, 2.0, 1.0])
        self.assertEqual(trend["direction"], "down")
        self.assertLess(trend["slope"], 0)
        self.assertAlmostEqual(trend["strength"], 1.0)

    def test_constant_series_is_flat_not_a_crash(self):
        """常数序列：没有波动可言，方向记 flat（不是 up/down），也不该除以 0。"""
        trend = linear_trend([3.0, 3.0, 3.0, 3.0])
        self.assertEqual(trend["direction"], "flat")
        self.assertEqual(trend["strength"], 0.0)
        self.assertEqual(trend["volatility"], 0.0)

    def test_turning_points_counted(self):
        """方向反转次数：上-下-上 = 2 个拐点。"""
        trend = linear_trend([1.0, 3.0, 1.0, 3.0])
        self.assertEqual(trend["turningPoints"], 2)

    def test_monotonic_series_has_no_turning_points(self):
        self.assertEqual(linear_trend([1.0, 2.0, 3.0, 4.0])["turningPoints"], 0)

    def test_non_numeric_ignored_before_counting(self):
        """非数值被丢掉后再数长度：3 个有效值走正常路径，而不是当成 5 个。"""
        trend = linear_trend([1.0, "x", 2.0, None, 3.0])
        self.assertIsNotNone(trend["slope"])
        self.assertEqual(trend["direction"], "up")


class TestDetectAnomalies(unittest.TestCase):
    def test_short_series_has_same_counts_keys_as_normal(self):
        """counts 的键两支要一致（第五十二批）：段太短时原来少一个 total。"""
        normal_counts = set(detect_anomalies([1, 2, 3, 4, 5, 6])["counts"])
        short = detect_anomalies([1, 2, 3, 4])
        self.assertEqual(short["items"], [])
        self.assertEqual(set(short["counts"]), normal_counts)
        self.assertEqual(short["counts"]["total"], 0)

    def test_obvious_outlier_is_flagged(self):
        values = [10.0, 10.1, 9.9, 10.2, 10.0, 10.1, 60.0]
        result = detect_anomalies(values)
        flagged = {item["index"] for item in result["items"]}
        self.assertIn(6, flagged)  # 那个 60 是第 7 个（下标 6）
        self.assertEqual(result["counts"]["total"], len(result["items"]))

    def test_items_capped_but_total_keeps_the_real_count(self):
        """items 截断到 max_items，而 counts.total 报的是**一共找出多少个**

        （前端那句「这里只列出最靠前的 N 个」就是读它）。
        """
        values = [10.0] * 12 + [80.0, 90.0, 95.0, 99.0]
        result = detect_anomalies(values, max_items=2)
        self.assertEqual(len(result["items"]), 2)
        self.assertGreater(result["counts"]["total"], 2)

    def test_flat_series_finds_nothing(self):
        self.assertEqual(detect_anomalies([2.0] * 10)["items"], [])


class TestAnalyzeSeries(unittest.TestCase):
    def test_bundle_has_the_three_parts(self):
        result = analyze_series([1.0, 2.0, 3.0, 4.0, 5.0, 6.0])
        self.assertEqual(set(result), {"summary", "trend", "anomalies"})
        self.assertEqual(result["summary"]["count"], 6)
        self.assertEqual(result["trend"]["direction"], "up")

    def test_short_input_does_not_raise(self):
        """整条链路在片段很少时也不能炸——接口那边虽然先拦了，但这里是纯函数。"""
        result = analyze_series([1.0, 2.0])
        self.assertEqual(result["summary"]["count"], 2)
        self.assertEqual(result["trend"]["direction"], "unknown")
        self.assertEqual(result["anomalies"]["items"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
