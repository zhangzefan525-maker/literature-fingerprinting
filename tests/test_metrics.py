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
    fit_pca_projection,
    function_word_matrix,
    get_top_keywords,
    project_blocks,
)
from src.data_loader import get_blocks, load_clean_text
from src.projection import build_model, compute_model_id, load_model, save_model


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


class TestHonoreMeasureR(unittest.TestCase):
    def test_known_counts(self):
        # 词频: a=2, b=2, c=1; N=5, V=3, V1=1
        # R = 100*ln(N) / (1 - V1/V)
        text = "a b c a b"
        expected = 100 * math.log(5) / (1 - 1 / 3)
        self.assertAlmostEqual(calc_hapax_legomena(text), expected, places=6)

    def test_single_token_returns_zero(self):
        # 只有一个词型时 V1 == V，按实现返回 0，避免除零
        self.assertEqual(calc_hapax_legomena("word"), 0.0)

    def test_repeated_token_returns_zero(self):
        # 没有只出现一次的词型时，公式结果为 100*ln(N)
        expected = 100 * math.log(3)
        self.assertAlmostEqual(calc_hapax_legomena("word word word"), expected, places=6)

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


class TestFunctionWordMatrix(unittest.TestCase):
    """功能词矩阵：必须按行归一化，否则第一主成分会退化成「这一段有多长」。"""

    VOCABULARY = ["the", "and", "of", "a", "to", "he", "she", "it"]

    def test_rows_sum_to_one(self):
        blocks = [
            "the the and of a",
            "he she it the and of a to",
            "the and of",
        ]
        matrix, vocabulary = function_word_matrix(blocks, vocabulary=self.VOCABULARY)
        self.assertEqual(list(vocabulary), self.VOCABULARY)
        for row in matrix:
            self.assertAlmostEqual(float(sum(row)), 1.0, places=9)

    def test_same_usage_different_length_gives_same_row(self):
        """同样的用词比例，长短不同也应该落在同一个点上。"""
        short = "the the and of"
        long = "the the and of the the and of"
        matrix, _ = function_word_matrix([short, long], vocabulary=self.VOCABULARY)
        for a, b in zip(matrix[0], matrix[1]):
            self.assertAlmostEqual(float(a), float(b), places=9)

    def test_row_without_function_words_stays_zero(self):
        """一个功能词都没有的块保持全 0，不能除零变成 nan。"""
        matrix, _ = function_word_matrix(["river mountain"], vocabulary=self.VOCABULARY)
        self.assertEqual(float(sum(matrix[0])), 0.0)

    def test_empty_blocks_returns_none(self):
        matrix, vocabulary = function_word_matrix([], vocabulary=self.VOCABULARY)
        self.assertIsNone(matrix)
        self.assertEqual(vocabulary, [])


class TestSharedProjection(unittest.TestCase):
    """共享投影：同一段文字在任何一本书里都得到同一坐标。"""

    VOCABULARY = ["the", "and", "of", "a", "to", "he", "she", "it"]

    BLOCKS_A = [
        "the the and of a to",
        "he she it the and",
        "of a to the the the",
    ]
    BLOCKS_B = [
        "she she it it the",
        "a a to to of and",
        "he the of a it she",
    ]

    def _matrix(self, blocks):
        matrix, _ = function_word_matrix(blocks, vocabulary=self.VOCABULARY)
        return matrix

    def test_same_block_same_coordinates_across_books(self):
        """在 A∪B 上拟合，A 的坐标与单独投影 A 完全一致——这就是「可比」。"""
        matrix_all = self._matrix(self.BLOCKS_A + self.BLOCKS_B)
        model = fit_pca_projection(matrix_all)
        together = project_blocks(matrix_all, model)
        alone = project_blocks(self._matrix(self.BLOCKS_A), model)

        for i in range(len(self.BLOCKS_A)):
            self.assertAlmostEqual(float(together[i][0]), float(alone[i][0]), places=9)
            self.assertAlmostEqual(float(together[i][1]), float(alone[i][1]), places=9)

    def test_new_block_projects_without_refitting(self):
        """新文本（比如用户上传的书）用同一个模型投影，旧书的坐标不能变。"""
        matrix_all = self._matrix(self.BLOCKS_A + self.BLOCKS_B)
        model = fit_pca_projection(matrix_all)
        before = project_blocks(matrix_all, model)

        extra = self._matrix(["the and of a to he she it"])
        project_blocks(extra, model)
        after = project_blocks(matrix_all, model)

        for i in range(len(self.BLOCKS_A + self.BLOCKS_B)):
            self.assertAlmostEqual(float(before[i][0]), float(after[i][0]), places=12)
            self.assertAlmostEqual(float(before[i][1]), float(after[i][1]), places=12)

    def test_sign_is_deterministic(self):
        """同一份矩阵拟合两次，主成分的方向必须一致；且最大载荷为正。"""
        matrix = self._matrix(self.BLOCKS_A + self.BLOCKS_B)
        first = fit_pca_projection(matrix)
        second = fit_pca_projection(matrix)

        self.assertEqual(first["components"], second["components"])
        for row in first["components"]:
            strongest = max(range(len(row)), key=lambda j: abs(row[j]))
            self.assertGreater(row[strongest], 0)

    def test_explained_variance_ratio_is_finite(self):
        """所有行相同（方差为 0）时 sklearn 会给出 nan，写进 JSON 会让文件读不出来。"""
        matrix = self._matrix(["the the and of a to"] * 3)
        model = fit_pca_projection(matrix)
        for ratio in model["explainedVarianceRatio"]:
            self.assertTrue(math.isfinite(ratio))


class TestModelPersistence(unittest.TestCase):
    """模型落盘 / 读回：同一份模型必须给出同一批坐标与同一个 modelId。"""

    VOCABULARY = ["the", "and", "of", "a", "to", "he", "she", "it"]

    def _fit(self):
        blocks = [
            "the the and of a to",
            "he she it the and",
            "of a to the the the",
            "she she it it the",
        ]
        matrix, vocabulary = function_word_matrix(blocks, vocabulary=self.VOCABULARY)
        return matrix, build_model(matrix, vocabulary, fitted_on={"books": ["synthetic"]})

    def test_round_trip_keeps_model_id_and_coordinates(self):
        matrix, model = self._fit()
        expected = project_blocks(matrix, model)

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pca_model.json"
            save_model(model, path)
            loaded = load_model(path)

        self.assertIsNotNone(loaded)
        self.assertEqual(loaded["modelId"], model["modelId"])
        self.assertEqual(model["modelId"], compute_model_id(model))
        self.assertEqual(loaded["components"], model["components"])

        actual = project_blocks(matrix, loaded)
        for i in range(len(matrix)):
            self.assertAlmostEqual(float(expected[i][0]), float(actual[i][0]), places=12)
            self.assertAlmostEqual(float(expected[i][1]), float(actual[i][1]), places=12)

    def test_missing_file_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(load_model(Path(tmp) / "not-there.json"))

    def test_broken_file_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pca_model.json"
            path.write_text("{ not json", encoding="utf-8")
            self.assertIsNone(load_model(path))

    def test_incomplete_model_returns_none(self):
        """缺 mean/components 的文件不用，免得投影时算出莫名其妙的结果。"""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pca_model.json"
            path.write_text('{"version": 1}', encoding="utf-8")
            self.assertIsNone(load_model(path))

    def test_axis_labels_are_plain_language(self):
        _, model = self._fit()
        labels = model["axisLabels"]
        self.assertEqual(len(labels), 2)
        for label in labels:
            self.assertIn("占的比例越高", label)


if __name__ == "__main__":
    unittest.main()
