"""
管线与章节识别单元测试
========================
覆盖 src/pipeline.py 的元数据口径与 src/data_loader.py 的章节识别，
重点锁住三件曾经出过错、或容易被后人改回去的事：

1. totalWords 必须是**真实词数**，不能是重叠窗口的词次累加
   （block 10000 / overlap 9000 ⇒ 步长 1000，累加会把《哈克贝利·费恩》
   的 11.1 万词显示成 102 万词）；
2. analyzedWords 必须等于 (块数-1)*步长 + 块长，两者分开记录；
3. 目录页里的 "CHAPTER I / II / III ..." 不能当成正文章节。

运行方式：
    python tests/test_pipeline.py
或：
    python -m unittest discover -s tests -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.data_loader import get_chapter_spans, get_blocks
from src.pipeline import SCHEMA_VERSION, build_book_data
from src.projection import build_model, compute_model_id, projection_metadata

# 指标计算依赖 NLTK 分词/停用词数据包。本机没装时跳过这些用例，
# 而不是让整个测试套件在离线环境下变红。
try:
    import nltk

    nltk.data.find("tokenizers/punkt")
    nltk.data.find("tokenizers/punkt_tab")
    nltk.data.find("corpora/stopwords")
    NLTK_READY = True
except Exception:  # pragma: no cover - 取决于运行环境
    NLTK_READY = False

requires_nltk = unittest.skipUnless(NLTK_READY, "本机缺少 NLTK 数据包（punkt/punkt_tab/stopwords）")


def filler(word_count, word="river"):
    """
    造一段指定词数的正文（全用同一个词，指标值不重要，词数准就行）。

    以句号结尾是必须的：章节标题只有在「前一个字符是句末标点」时才算标题，
    正文里没有句号的话，下一章的标题会被判成正文中的偶然命中。
    """
    return " ".join([word] * max(0, word_count - 1) + ["end."]) if word_count > 0 else ""


def make_text(chapter_bodies, heading="Chapter", start=1):
    """
    造一本有章节的小说：每章一个标题 + 一段正文。

    标题前留了句号，满足「标题语境」规则（标题前应是句子结束符或文本开头）。
    """
    ordinals = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"]
    parts = ["The story begins here."]
    for i, body_words in enumerate(chapter_bodies):
        number = ordinals[start - 1 + i] if start - 1 + i < len(ordinals) else str(start + i)
        parts.append(f"{heading} {number}. {filler(body_words)}")
    return " ".join(parts)


class TestTotalWordsIsReal(unittest.TestCase):
    """两个词数口径必须分开，且都不是窗口累加。"""

    TEXT = filler(30)  # 30 词
    BLOCKS = [filler(10, w) for w in ("alpha", "beta", "gamma", "delta")]  # 4 块 × 10 词

    @requires_nltk
    def test_total_words_is_real_not_window_sum(self):
        data = build_book_data(self.BLOCKS, text=self.TEXT,
                              block_size=10, overlap=5)
        window_sum = sum(len(b.split()) for b in self.BLOCKS)
        self.assertEqual(data["metadata"]["totalWords"], 30)
        self.assertNotEqual(data["metadata"]["totalWords"], window_sum)
        self.assertEqual(window_sum, 40)  # 重叠让词次累加虚高，正是曾经的 bug 来源

    @requires_nltk
    def test_analyzed_words_formula(self):
        data = build_book_data(self.BLOCKS, text=self.TEXT, block_size=10, overlap=5)
        meta = data["metadata"]
        # (4-1)*5 + 10 = 25
        self.assertEqual(meta["analyzedWords"], 25)
        self.assertEqual(meta["analyzedWords"], (len(self.BLOCKS) - 1) * meta["step"] + meta["blockSize"])
        self.assertGreater(meta["totalWords"], 0)

    @requires_nltk
    def test_schema_version_and_block_params(self):
        data = build_book_data(self.BLOCKS, text=self.TEXT, block_size=10, overlap=5)
        meta = data["metadata"]
        self.assertEqual(meta["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(meta["blockSize"], 10)
        self.assertEqual(meta["overlap"], 5)
        self.assertEqual(meta["step"], 5)
        self.assertEqual(meta["totalBlocks"], 4)

    @requires_nltk
    def test_without_text_word_count_is_null_not_guessed(self):
        """拿不到全文时如实给 None，不拿窗口词次冒充总词数。"""
        data = build_book_data(self.BLOCKS, block_size=10, overlap=5)
        meta = data["metadata"]
        self.assertIsNone(meta["totalWords"])
        self.assertIsNone(meta["chapters"])
        self.assertEqual(meta["analyzedWords"], 25)


class TestChapterDetection(unittest.TestCase):
    def test_too_few_chapters_returns_none(self):
        text = make_text([400])
        self.assertIsNone(get_chapter_spans(text))

    def test_empty_text_returns_none(self):
        self.assertIsNone(get_chapter_spans(""))

    def test_front_matter_toc_is_dropped(self):
        """目录页里挤在一起的标题整簇丢弃，正文标题要留下来。"""
        toc = "Contents. " + " ".join([
            "Chapter I The Boy", "Chapter II The Girl",
            "Chapter III The Dog", "Chapter IV The End",
        ])
        body = make_text([400, 380, 420])
        text = f"{toc} {body}"

        chapters = get_chapter_spans(text)
        self.assertIsNotNone(chapters)
        # 目录里 4 条 + 正文 3 条 = 7 处命中，只应留下正文的 3 章
        self.assertEqual(len(chapters), 3)
        # 第一章必须落在正文区（目录之后），而不是目录的第一条
        self.assertGreater(chapters[0]["wordStart"], len(toc.split()))

    def test_chapter_spans_are_monotonic_and_cover_to_the_end(self):
        text = make_text([400, 380, 420])
        chapters = get_chapter_spans(text)
        self.assertEqual(len(chapters), 3)

        total_words = len(text.split())
        for i, chapter in enumerate(chapters):
            self.assertEqual(chapter["index"], i)
            self.assertLess(chapter["wordStart"], chapter["wordEnd"])
            if i + 1 < len(chapters):
                # 上一章的结束就是下一章的开始，中间不留缝也不重叠
                self.assertEqual(chapter["wordEnd"], chapters[i + 1]["wordStart"])
        self.assertEqual(chapters[-1]["wordEnd"], total_words)

    def test_ordinal_reset_keeps_every_part(self):
        """分「部」的小说每部从 CHAPTER I 重新编号，不能按序号去重把前面几部抹掉。"""
        text = make_text([400, 380, 420]) + " " + make_text([400, 380, 420])
        chapters = get_chapter_spans(text)
        self.assertIsNotNone(chapters)
        # 两部各 3 章，一章都不能少（写成 >= 6 时，少认的章会从这里溜过去）
        self.assertEqual(len(chapters), 6)
        self.assertEqual([c["title"] for c in chapters],
                         ["Chapter I", "Chapter II", "Chapter III"] * 2)


class TestProjectionMetadata(unittest.TestCase):
    """投影模式的标注：共享模型才叫可比。"""

    # 块里必须真有功能词，否则每行归一化后全是 0，PCA 就没什么可拟合的了
    BLOCKS = [
        "the river and of a to in that it was his her with the river and of a to in that it was his end.",
        "he said to her that the river was in it and of a to the river his end.",
        "and the of a to in that it was his her with the river and of a to he said end.",
        "it was the river and of a to in that he said to her his end.",
        "of a to in the river it was his her with the and that he said end.",
        "the river his her with the of a to in that it was and he said end.",
    ]

    @requires_nltk
    def test_no_model_marks_per_book(self):
        data = build_book_data(self.BLOCKS, text=filler(60), block_size=10, overlap=5)
        projection = data["metadata"]["projection"]
        self.assertEqual(projection["mode"], "perBook")
        self.assertIsNone(projection["modelId"])

    @requires_nltk
    def test_shared_model_marks_shared_and_records_model_id(self):
        from src.metrics import function_word_matrix

        # 用与 build_book_data 相同的词表（NLTK 英语停用词）拟合，列才能对上
        matrix, vocabulary = function_word_matrix(self.BLOCKS)
        model = build_model(matrix, vocabulary, fitted_on={"books": ["synthetic"]})

        data = build_book_data(self.BLOCKS, text=filler(60), block_size=10, overlap=5, projection=model)
        projection = data["metadata"]["projection"]
        self.assertEqual(projection["mode"], "shared")
        self.assertEqual(projection["modelId"], compute_model_id(model))
        self.assertTrue(projection["modelId"].startswith("pca-"))
        self.assertEqual(projection["axisLabels"], model["axisLabels"])

    @requires_nltk
    def test_projection_metadata_handles_missing_model(self):
        self.assertEqual(projection_metadata(None)["mode"], "perBook")

    @requires_nltk
    def test_vectors_only_persisted_when_requested(self):
        """逐块功能词向量是给书库落盘用的内部字段，默认不下发。"""
        plain = build_book_data(self.BLOCKS, text=filler(60), block_size=10, overlap=5)
        self.assertNotIn("_functionWordVectors", plain)

        detailed = build_book_data(self.BLOCKS, text=filler(60), block_size=10, overlap=5,
                                   include_vectors=True)
        self.assertIn("_functionWordVectors", detailed)
        self.assertEqual(len(detailed["_functionWordVectors"]["matrix"]), len(self.BLOCKS))


class TestRealBookRegression(unittest.TestCase):
    """真实语料的回归：词数与块参数的口径必须和生成脚本一致。"""

    ALL_BOOKS = Path(__file__).resolve().parents[1] / "data" / "processed" / "all_books.json"
    HUCK = "The Adventures of Huckleberry Finn"

    @unittest.skipUnless(ALL_BOOKS.exists(), "未生成 data/processed/all_books.json，跳过真实语料回归")
    def test_builtin_books_use_real_word_counts(self):
        import json

        with open(self.ALL_BOOKS, "r", encoding="utf-8") as f:
            data = json.load(f)

        book = data.get(self.HUCK)
        if book is None:  # pragma: no cover - 取决于数据文件内容
            self.skipTest(f"数据文件里没有《{self.HUCK}》")

        meta = book["metadata"]
        self.assertEqual(meta["schemaVersion"], SCHEMA_VERSION)
        blocks = book["sentenceLength"]
        window_sum = sum(item.get("wordCount", 0) for item in blocks)

        self.assertEqual(meta["totalBlocks"], len(blocks))
        self.assertEqual(meta["analyzedWords"], (len(blocks) - 1) * meta["step"] + meta["blockSize"])
        # 真实词数必须明显小于窗口累加（重叠率 90% ⇒ 累加约 10 倍）
        self.assertLess(meta["totalWords"], window_sum / 5)
        self.assertIsNotNone(meta["chapters"])
        self.assertGreaterEqual(len(meta["chapters"]), 2)

    @unittest.skipUnless(ALL_BOOKS.exists(), "未生成 data/processed/all_books.json，跳过真实语料回归")
    def test_builtin_books_share_one_projection_model(self):
        import json

        with open(self.ALL_BOOKS, "r", encoding="utf-8") as f:
            data = json.load(f)

        model_ids = set()
        for name, book in data.items():
            projection = book.get("metadata", {}).get("projection")
            if not projection:
                continue
            self.assertEqual(projection["mode"], "shared", f"{name} 不在共享投影下")
            model_ids.add(projection["modelId"])
        if model_ids:
            self.assertEqual(len(model_ids), 1, f"多本书用了不同的投影模型: {model_ids}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
