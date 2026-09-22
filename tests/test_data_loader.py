"""
数据加载与章节定位单元测试
============================
覆盖 src/data_loader.py 的滑窗切分与章节识别。

关心两件事：
1. 滑窗切出来的块数与词位置要对得上（章节定位全靠这个坐标换算）；
2. 章节标题识别既不能漏真标题，也不能把正文里的 "in this chapter I will..."
   当成章节——少认一章只是少一条信息，多认一章会让「第几章」直接指错地方。

运行方式：
    python tests/test_data_loader.py
或：
    python -m unittest discover -s tests -v
"""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.data_loader import (
    BLOCK_SIZE,
    OVERLAP,
    clean_text,
    detect_language,
    get_blocks,
    get_chapter_spans,
    load_clean_text,
)


def words(count, word="river", tail="end."):
    """造 count 个词的句子（以句末标点结尾，标题识别需要）。"""
    return " ".join([word] * max(0, count - 1) + [tail]) if count > 0 else ""


class TestGetBlocks(unittest.TestCase):
    def test_step_is_block_size_minus_overlap(self):
        text = " ".join(f"w{i}" for i in range(120))
        blocks = get_blocks(text, block_size=100, overlap=90)  # step = 10
        self.assertEqual(len(blocks), 3)  # 起点 0 / 10 / 20（20+100=120 刚好放得下）
        self.assertEqual(len(blocks[0].split()), 100)

    def test_blocks_slide_by_step(self):
        text = " ".join(f"w{i}" for i in range(300))
        blocks = get_blocks(text, block_size=100, overlap=60)  # step = 40
        self.assertEqual(len(blocks), 6)
        first = blocks[0].split()
        second = blocks[1].split()
        # 第 2 块的第 1 个词 = 第 1 块的第 41 个词
        self.assertEqual(second[0], first[40])

    def test_not_enough_words_gives_no_blocks(self):
        self.assertEqual(get_blocks("short text", block_size=100, overlap=90), [])

    def test_default_parameters_match_thesis_settings(self):
        # 论文参数：块 1 万词、重叠 9 千、步长 1 千。改了要同步改前端文案与文档。
        self.assertEqual(BLOCK_SIZE, 10000)
        self.assertEqual(OVERLAP, 9000)


class TestChapterSpans(unittest.TestCase):
    def test_prose_mention_of_chapter_is_not_a_heading(self):
        """正文里 "in this chapter I will explain" 不是章节标题。"""
        text = (
            "The author explains his method. "
            "In this chapter I will explain everything about the river. "
            + words(600)
        )
        self.assertIsNone(get_chapter_spans(text))

    def test_real_headings_are_found(self):
        text = (
            "The story begins here. "
            f"Chapter I. {words(500)} "
            f"Chapter II. {words(500)}"
        )
        chapters = get_chapter_spans(text)
        self.assertIsNotNone(chapters)
        self.assertEqual(len(chapters), 2)
        self.assertIn("Chapter I", chapters[0]["title"])
        self.assertIn("Chapter II", chapters[1]["title"])

    def test_spans_are_monotonic(self):
        text = (
            "The story begins here. "
            f"Chapter I. {words(500)} "
            f"Chapter II. {words(400)} "
            f"Chapter III. {words(600)}"
        )
        chapters = get_chapter_spans(text)
        self.assertEqual(len(chapters), 3)
        starts = [chapter["wordStart"] for chapter in chapters]
        self.assertEqual(starts, sorted(starts))
        self.assertEqual(len(set(starts)), len(starts))
        for previous, current in zip(chapters, chapters[1:]):
            self.assertEqual(previous["wordEnd"], current["wordStart"])
        self.assertEqual(chapters[-1]["wordEnd"], len(text.split()))


class TestPartHeadings(unittest.TestCase):
    """
    分「部」的小说：每部都从 CHAPTER I 重新编号。

    这种书里「CHAPTER I」前面紧挨着的是「PART II」这样的部标题，
    末尾是罗马数字、不是句末符，会被「标题前应是句末符」的规则误杀。
    实测《白牙》因此少认 4 章（21 → 真值 25）。
    """

    def test_chapter_after_part_heading_is_recognized(self):
        text = (
            "PART I\n"
            f"CHAPTER I\n{words(500)}\n"
            "PART II\n"
            f"CHAPTER I\n{words(500)}\n"
            "CHAPTER II\n"
            f"{words(500)}"
        )
        chapters = get_chapter_spans(text)
        self.assertIsNotNone(chapters)
        # 两部各一章 + 第二部的第二章 = 3 章；少认的话只会剩 1 章
        self.assertEqual(len(chapters), 3)
        self.assertEqual([c["title"] for c in chapters], ["CHAPTER I", "CHAPTER I", "CHAPTER II"])
        self.assertEqual([c["part"] for c in chapters], ["PART I", "PART II", "PART II"])

    def test_lowercase_part_in_prose_is_not_an_anchor(self):
        """散文里的 "part I" 不是部标题，不能把后面的句子救成章节。"""
        text = (
            "He explained the first part I had missed entirely. "
            "In this chapter I will explain the river. "
            + words(600)
        )
        self.assertIsNone(get_chapter_spans(text))

    def test_part_is_none_when_book_has_no_parts(self):
        text = f"Chapter I. {words(500)} Chapter II. {words(500)}"
        chapters = get_chapter_spans(text)
        self.assertEqual([chapter["part"] for chapter in chapters], [None, None])


class TestRealCorpusChapterCounts(unittest.TestCase):
    """
    真实语料的章节数回归。

    以前这里只断言「章节数 >= 2」，所以《白牙》少认 4 章能一路绿灯——
    章号、分界线、导出里的「第几章」全跟着错。现在把四本内置书的
    章节数钉死：数不对就是回归，必须查清原因再改这些数字。
    """

    RAW_DIR = ROOT / "data" / "raw"
    EXPECTED = {
        "The Adventures of Huckleberry Finn": 43,
        "The Adventures of Tom Sawyer": 35,
        "The call of the wild": 7,
        "White Fang": 25,
    }

    def _chapters(self, name):
        path = self.RAW_DIR / f"{name}.txt"
        if not path.exists():  # pragma: no cover - 取决于仓库内容
            self.skipTest(f"缺少语料 {path}")
        return get_chapter_spans(load_clean_text(path))

    def test_chapter_counts(self):
        for name, expected in self.EXPECTED.items():
            with self.subTest(book=name):
                chapters = self._chapters(name)
                self.assertIsNotNone(chapters, f"{name} 一章都没识别出来")
                self.assertEqual(len(chapters), expected, f"{name} 的章节数变了")

    def test_white_fang_part_attribution(self):
        """《白牙》分 5 部，每部从 CHAPTER I 重新编号：章号是全局的第几章，标题是部内的 CHAPTER N。"""
        chapters = self._chapters("White Fang")
        # 第 16 章标题是 PART IV 里的 CHAPTER II —— 导出里最容易读错的一条
        self.assertEqual(chapters[15]["title"], "CHAPTER II")
        self.assertEqual(chapters[15]["part"], "PART IV")
        self.assertEqual(chapters[0]["part"] is None, True)  # 正文没有 PART I 标题，不编

    def test_books_without_parts_have_no_part(self):
        for name in self.EXPECTED:
            if name == "White Fang":
                continue
            with self.subTest(book=name):
                chapters = self._chapters(name)
                self.assertEqual({c["part"] for c in chapters}, {None}, f"{name} 认出了不该有的部标题")


class TestRealCorpusChapterCoordinates(unittest.TestCase):
    """真实语料回归：章节词坐标必须落在全书词数范围内、且与块坐标能对上。"""

    ALL_BOOKS = ROOT / "data" / "processed" / "all_books.json"

    @unittest.skipUnless(ALL_BOOKS.exists(), "未生成 data/processed/all_books.json，跳过真实语料回归")
    def test_chapter_coordinates_within_book(self):
        with open(self.ALL_BOOKS, "r", encoding="utf-8") as f:
            data = json.load(f)

        checked = 0
        for name, book in data.items():
            chapters = book.get("metadata", {}).get("chapters")
            if not chapters:
                continue
            total_words = book["metadata"].get("totalWords")
            checked += 1

            starts = [chapter["wordStart"] for chapter in chapters]
            self.assertEqual(starts, sorted(starts), f"{name} 的章节起点不是递增的")
            # 第一章不一定从第 0 个词开始（前面可能有题记、告示等非章节内容），
            # 但必须落在全书范围内
            self.assertGreaterEqual(chapters[0]["wordStart"], 0)
            if total_words:
                # 最后一章要正好收在全书的末尾
                self.assertEqual(chapters[-1]["wordEnd"], total_words, f"{name} 的末章没有覆盖到全书结尾")
            for chapter in chapters:
                self.assertLess(chapter["wordStart"], chapter["wordEnd"], f"{name} 出现空章节")
                if total_words:
                    self.assertLessEqual(chapter["wordEnd"], total_words, f"{name} 的章节超出全书范围")

        if checked == 0:  # pragma: no cover - 取决于数据文件内容
            self.skipTest("数据里没有任何带章节信息的书")


class TestCleanText(unittest.TestCase):
    """
    clean_text 是内置书与上传书共用的清洗管线。

    以前只有内置书走清洗（load_clean_text），上传路径直接用原始文本，
    界面却声明「文本经页眉页脚清理与缩写还原后」——口径必须统一。
    """

    RAW = (
        "Header noise.\n"
        "*** START OF THE PROJECT GUTENBERG EBOOK TITLE ***\n"
        "He said he don't know.\n"
        "*** END OF THE PROJECT GUTENBERG EBOOK TITLE ***\n"
        "License noise."
    )

    def test_clean_text_strips_markers_and_expands_contractions(self):
        cleaned = clean_text(self.RAW)
        self.assertNotIn("START OF THE PROJECT GUTENBERG", cleaned)
        self.assertNotIn("License noise", cleaned)
        self.assertIn("do not know", cleaned)

    def test_load_clean_text_matches_clean_text(self):
        """load_clean_text 只是「读文件 + clean_text」，两者结果必须一字不差。"""
        path = ROOT / "data" / "raw" / "The call of the wild.txt"
        if not path.exists():  # pragma: no cover - 取决于仓库内容
            self.skipTest("缺少语料")
        self.assertEqual(load_clean_text(path), clean_text(path.read_text(encoding="utf-8")))


class TestDetectLanguage(unittest.TestCase):
    """
    上传入口的语言闸门。

    两个信号各管一边：非 ASCII 占比管中文（没空格，会被当成 1 个「单词」，
    结果只会报「文本太短」）；英文停用词命中率管法文这类有空格的非英文
    （非 ASCII 只有千分之几，光看字符集抓不住，但算出来的数值全无意义）。

    这里的阈值不是拍脑袋：下面用四本真实英文小说锁定余量，
    任何一边漂了，测试会先红。
    """

    BUILTIN_BOOKS = (
        "The Adventures of Huckleberry Finn.txt",
        "The Adventures of Tom Sawyer.txt",
        "The call of the wild.txt",
        "White Fang.txt",
    )

    def _read_builtin(self, name):
        path = ROOT / "data" / "raw" / name
        if not path.exists():  # pragma: no cover - 取决于仓库内容
            self.skipTest(f"缺少语料 {name}")
        return path.read_text(encoding="utf-8")

    def test_real_english_novels_pass_with_margin(self):
        """四本内置书必须通过，且离阈值有足够余量（否则下次调阈值就是拍脑袋）。"""
        for name in self.BUILTIN_BOOKS:
            with self.subTest(book=name):
                ok, reason, stats = detect_language(self._read_builtin(name))
                self.assertTrue(ok, f"{name} 被误判：{reason}")
                self.assertLess(stats["nonAsciiRatio"], 0.05, "非 ASCII 占比余量变薄了")
                self.assertGreater(stats["stopwordHitRatio"], 0.40, "停用词命中率余量变薄了")

    def test_chinese_text_rejected_by_non_ascii(self):
        text = "白牙是一本关于狼的小说。" * 40
        ok, reason, stats = detect_language(text)
        self.assertFalse(ok)
        self.assertIn("不是英文", reason)
        self.assertGreater(stats["nonAsciiRatio"], 0.9)  # 中文实测约 1.00

    def test_french_text_rejected_by_stopwords_even_though_ascii(self):
        """法文是「有空格的非英文」：非 ASCII 占比很低，只能靠停用词命中率抓住。"""
        text = (
            "Le chien etait dans la neige et il ne voulait pas partir. "
            "Elle regardait les arbres de la foret avec une grande tristesse. "
        ) * 40
        ok, reason, stats = detect_language(text)
        self.assertFalse(ok, f"法文样本没被拦住（命中率 {stats['stopwordHitRatio']}）")
        self.assertIn("不是英文", reason)
        self.assertLess(stats["nonAsciiRatio"], 0.15)  # 证明拦住它的不是字符集那条
        self.assertLess(stats["stopwordHitRatio"], 0.15)

    def test_short_english_sample_is_not_judged(self):
        """短样本的词频不可靠，只跳过第二条——太短这件事交给「文本太短」分支说。"""
        ok, reason, _ = detect_language("He said he do not know about the river.")
        self.assertTrue(ok, f"短英文被误判：{reason}")

    def test_english_with_typographic_quotes_passes(self):
        """中文排版常见的弯引号、破折号不该把人误伤成「非英文」。"""
        text = "“He said he was not going,” she said—and the river went on. " * 40
        ok, reason, _ = detect_language(text)
        self.assertTrue(ok, f"带排版符号的英文被误判：{reason}")

    def test_empty_and_blank_are_not_rejected_here(self):
        """空文本由调用方（内容为空 / 清洗后为空）给提示，这里不抢答。"""
        for text in ("", "   \n  "):
            with self.subTest(text=repr(text)):
                ok, reason, _ = detect_language(text)
                self.assertTrue(ok)
                self.assertIsNone(reason)


if __name__ == "__main__":
    unittest.main(verbosity=2)
