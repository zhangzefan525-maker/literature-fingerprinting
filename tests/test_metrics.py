"""
指标计算单元测试
==================
覆盖 src/metrics.py 与 src/data_loader.py 的核心公式，
用于回归验证论文复现的数学正确性。

运行方式：
    python tests/test_metrics.py
或：
    python -m unittest discover -s tests -v
"""
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path

# 确保项目根目录在 sys.path 中，便于 from src.xxx import ...
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.metrics import (
    calc_sentence_length,
    calc_simpsons_index,
    calc_hapax_legomena,
    get_top_keywords,
)
from src.data_loader import get_blocks, load_clean_text


class TestAverageSentenceLength(unittest.TestCase):
    def test_two_sentences(self):
        # "This is a short sentence." = 5 词；"This one is a bit longer indeed." = 7 词
        text = "This is a short sentence. This one is a bit longer indeed."
        self.assertAlmostEqual(calc_sentence_length(text), 6.0, places=6)

    def test_empty_returns_zero(self):
        self.assertEqual(calc_sentence_length(""), 0.0)


class TestSimpsonsIndex(unittest.TestCase):
    def test_known_counts(self):
        # 词频: a=2, b=2; N=4
        # D = (2*1 + 2*1) / (4*3) = 4/12
        text = "a b a b"
        self.assertAlmostEqual(calc_simpsons_index(text), 4 / 12, places=6)

    def test_single_token_returns_zero(self):
        # N < 2 时按实现返回 0
        self.assertEqual(calc_simpsons_index("lonely"), 0.0)


class TestHapaxLegomena(unittest.TestCase):
    def test_known_counts(self):
        # 词频: a=2, b=2, c=1; N=5, V=3, V1=1
        # R = 100*ln(N) / (1 - V1/V)
        text = "a b c a b"
        expected = 100 * math.log(5) / (1 - 1 / 3)
        self.assertAlmostEqual(calc_hapax_legomena(text), expected, places=6)

    def test_all_unique_returns_zero(self):
        # V1 == V 时按实现返回 0，避免除零
        self.assertEqual(calc_hapax_legomena("a b c"), 0.0)

    def test_empty_returns_zero(self):
        self.assertEqual(calc_hapax_legomena(""), 0.0)


class TestTopKeywords(unittest.TestCase):
    def test_top_two(self):
        text = "river river river blood blood dark"
        # 停用词过滤后：river=3, blood=2, dark=1
        self.assertEqual(get_top_keywords(text, n=2), ["river", "blood"])

    def test_stopwords_filtered(self):
        text = "the and of river"
        # the/and/of 为停用词，应被过滤，只剩 river
        self.assertEqual(get_top_keywords(text, n=5), ["river"])


class TestGetBlocks(unittest.TestCase):
    def test_step_and_count(self):
        words = " ".join(f"w{i}" for i in range(25))
        blocks = get_blocks(words, block_size=10, overlap=8)  # step = 2
        # range(0, 16, 2) -> 8 个块
        self.assertEqual(len(blocks), 8)
        self.assertEqual(len(blocks[0].split()), 10)

    def test_short_text_no_blocks(self):
        self.assertEqual(get_blocks("too short", block_size=1000, overlap=900), [])


class TestLoadCleanText(unittest.TestCase):
    def test_gutenberg_markers_stripped(self):
        # load_clean_text 接收文件路径，故先写入临时文件
        raw = (
            "Some header noise.\n"
            "*** START OF THE PROJECT GUTENBERG EBOOK TITLE ***\n"
            "This is the real body text.\n"
            "*** END OF THE PROJECT GUTENBERG EBOOK TITLE ***\n"
            "Trailing license noise."
        )
        with tempfile.NamedTemporaryFile(
            mode='w', suffix='.txt', encoding='utf-8', delete=False
        ) as f:
            f.write(raw)
            tmp_path = f.name
        try:
            cleaned = load_clean_text(tmp_path)
        finally:
            os.remove(tmp_path)

        self.assertIn("real body text", cleaned)
        self.assertNotIn("START OF THE PROJECT GUTENBERG", cleaned)
        self.assertNotIn("license noise", cleaned)


if __name__ == "__main__":
    unittest.main()
