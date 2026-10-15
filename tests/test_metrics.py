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
import re
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest import mock

# 确保项目根目录在 sys.path 中，便于 from src.xxx import ...
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.metrics import (
    calc_sentence_length,
    calc_simpsons_index,
    calc_hapax_legomena,
    fit_pca_projection,
    function_word_matrix,
    get_distinctive_words,
    get_top_keywords,
    log_likelihood_ratio,
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

    def test_lookup_error_is_not_papered_over_by_a_download(self):
        """停用词取不到时**不**在调用里现下（第五十二批）。

        下载点全项目只有 pipeline._ensure_nltk_data() 一处，而它一定比这里先跑
        （build_book_data 在本函数之前就调过它）。原来这里挂着
        try/except: nltk.download('stopwords')——它并没有兜住任何东西
        （下载失败照样抛 LookupError），却会在断网的机器上把一次用户请求
        同步挂住几十秒去等网络。

        这里故意让取词表失败：正确的行为是把 LookupError 直接抛出去（上层
        _ensure_nltk_data 已经试过下载了），而不是在这里现下一把。
        """
        with mock.patch("nltk.corpus.stopwords.words", side_effect=LookupError("no data")), \
             mock.patch("nltk.download") as download:
            with self.assertRaises(LookupError):
                get_top_keywords("river river blood", n=2)

        download.assert_not_called()


class TestLogLikelihoodRatio(unittest.TestCase):
    """对数似然比 G² 的公式本身（第五十九批）。

    这个公式最容易写错的地方是四个格的**行列边际**——a/b 同一行、a/c 同一列。
    写错时数值不会变成 nan 或负数，只会整批挤到一个几乎相同的量级上（我自己
    第一版就是这样：所有分都落在 11 万附近、名次看起来像噪声）。所以这里拿
    手算得出的具体数字钉死，而不只是断言「正数」「越大越好」。
    """

    def test_known_value(self):
        # a=10,b=90（目标语料 100 词，该词占 10%）、c=1,d=499（参考语料 500 词，占 0.2%）
        self.assertAlmostEqual(log_likelihood_ratio(10, 90, 1, 499),
                               30.3320363758, places=6)

    def test_equal_rates_give_zero(self):
        # 两份语料里占比都是 10%：没有「偏多」可言，G² 必须是 0
        self.assertEqual(log_likelihood_ratio(10, 90, 50, 450), 0.0)

    def test_symmetric_under_swap(self):
        # 把目标语料和参考语料对调，G² 不变（公式本身是对称的；
        # 「只收偏多」是 get_distinctive_words 那一层的判断，不是公式的）
        self.assertAlmostEqual(log_likelihood_ratio(10, 90, 1, 499),
                               log_likelihood_ratio(1, 499, 10, 90), places=10)

    def test_zero_cell_contributes_nothing(self):
        # 参考语料里一次都没出现（c=0）：这一格按 0·ln0 = 0 处理，不能抛异常
        self.assertAlmostEqual(log_likelihood_ratio(8, 92, 0, 500),
                               29.2187915361, places=6)

    def test_empty_table(self):
        self.assertEqual(log_likelihood_ratio(0, 0, 0, 0), 0.0)

    def test_grows_with_the_effect(self):
        # 同一个比例、更大的样本：证据更强
        weak = log_likelihood_ratio(1, 99, 1, 499)
        strong = log_likelihood_ratio(10, 90, 10, 490)
        self.assertLess(weak, strong)


class TestDistinctiveWords(unittest.TestCase):
    """特征词（keyness）的挑选规则（第五十九批）。

    构造一份可控语料：fence/beetle 在这一段偏多，river/once 在这一段偏少，
    minor/rare 出现次数不够，huck 这一段根本没出现。
    """

    def setUp(self):
        self.block = Counter({
            'fence': 8, 'beetle': 8, 'river': 5, 'once': 3, 'minor': 2, 'rare': 1,
        })
        # book_counter 是**整本书**（含本段），函数内部自己扣掉本段当参考语料
        self.book = self.block + Counter({
            'river': 200, 'once': 150, 'fence': 4, 'beetle': 3, 'huck': 300,
        })

    def test_over_represented_only(self):
        words = [w for w, _ in get_distinctive_words(self.block, self.book, n=5)]
        self.assertEqual(words, ['beetle', 'fence'])
        # river/once 这一段远低于全书水平，绝不能出现——「这一段在讲什么」
        # 用「某个词缺席」回答不了，混进来会把「哈克不在场」顶成关键词
        self.assertNotIn('river', words)
        self.assertNotIn('once', words)

    def test_absent_from_block_never_appears(self):
        words = [w for w, _ in get_distinctive_words(self.block, self.book, n=5)]
        self.assertNotIn('huck', words)

    def test_scores_are_paired_and_rounded(self):
        got = get_distinctive_words(self.block, self.book, n=5)
        self.assertEqual(got, [('beetle', 41.5), ('fence', 39.2)])
        for _word, score in got:
            self.assertEqual(score, round(score, 1))

    def test_min_count_filters(self):
        # minor(2) / rare(1) 都够不上段内最少 3 次
        words = [w for w, _ in get_distinctive_words(self.block, self.book,
                                                     n=5, min_count=3)]
        self.assertNotIn('minor', words)
        self.assertNotIn('rare', words)
        # 把下限抬到 9，谁都不够格
        self.assertEqual(get_distinctive_words(self.block, self.book, n=5,
                                               min_count=9), [])

    def test_min_g2_filters(self):
        self.assertEqual(get_distinctive_words(self.block, self.book, n=5,
                                               min_g2=100), [])

    def test_tie_break_is_alphabetical(self):
        # alpha 与 beta 次数完全一样，G² 也必然一样：按字母序，结果才可复现
        block = Counter({'alpha': 5, 'beta': 5, 'gamma': 9})
        book = block + Counter({'other': 500})
        got = [w for w, _ in get_distinctive_words(block, book, n=3)]
        self.assertEqual(got, ['gamma', 'alpha', 'beta'])

    def test_empty_block_returns_empty(self):
        self.assertEqual(get_distinctive_words(Counter(), self.book), [])

    def test_reference_is_book_minus_block(self):
        """参考语料必须是「这本书的其它部分」，不是整本书。

        忘掉扣本段这一步，数值不会报错、名次也大体对，所以只能用具体数字钉死：
        段内 a=4、全书 a=10 时，参考语料里的 a 应当是 6（不是 10）。
        """
        block = Counter({'a': 4, 'b': 6})
        book = Counter({'a': 10, 'b': 100})            # 扣掉本段 → {'a': 6, 'b': 94}
        self.assertEqual(get_distinctive_words(block, book, n=3, min_g2=0),
                         [('a', 8.2)])
        # 手算：G²(段内 4、段内其它 6；参考 6、参考其它 94)
        self.assertAlmostEqual(log_likelihood_ratio(4, 6, 6, 94), 8.1662035765,
                               places=6)

    def test_book_that_is_only_this_block_returns_empty(self):
        """全书就这一段时，参考语料是空的——此时说不出「偏多」。

        期望值退化成段内规模本身（9/10 vs 9），于是没有词能超过期望值。
        这是个**界定**：滑窗切出来的书不可能只有一段，但上传路径将来若改成
        按段算，这里会安静地返回空，而不是拿整本书冒充参考。
        """
        block = Counter({'fence': 9, 'other': 1})
        self.assertEqual(get_distinctive_words(block, block, n=3, min_g2=0), [])


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

    def test_axis_labels_keep_opposite_signs_apart(self):
        """
        一句方向断言只能管一个方向。

        载荷是**带符号**的，正负代表坐标轴相反的两端；把正号词和负号词混进同一句
        「越靠某端，这些词占比越高」里，混进来的那一半无论比例尺朝哪边都必然说反。
        所以每一段（以「；」分隔）里被点名的词必须同号 —— 这是不依赖具体数据的
        不变式，换语料、换模型都成立。
        """
        _, model = self._fit()
        vocabulary = model["vocabulary"]
        self.assertEqual(len(model["axisLabels"]), 2)
        for row, label in zip(model["components"][:2], model["axisLabels"]):
            clauses = label.split("；")
            self.assertTrue(clauses)
            for clause in clauses:
                matched = re.search(r"，([^，；]+?)\s*这类小词", clause)
                self.assertIsNotNone(matched, f"这段话里没有可取词的表：{clause}")
                signs = {
                    row[vocabulary.index(word.strip())] > 0
                    for word in matched.group(1).split("/")
                }
                self.assertEqual(len(signs), 1, f"同一段里混了正负号：{clause}")


if __name__ == "__main__":
    unittest.main()
