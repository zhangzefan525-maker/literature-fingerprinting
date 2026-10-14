# -*- coding: utf-8 -*-
"""作者归属（`src/authorship.py` 与 `/api/authorship`）的测试。

分三块，速度差得很远，所以刻意分开：

  · `AuthorshipUnitTestCase` —— 纯逻辑、不碰真实语料，毫秒级。
  · `AuthorshipRealCorpusTestCase` —— 拿真实的四本书跑一遍完整分析。**十几秒**，
    所以整份结果放在 `setUpClass` 里只算一次，各条断言共用。这一块是唯一能证明
    「这个页签说的数字是真的」的东西，删不得。
  · `AuthorshipApiTestCase` —— 只验接口的接线（状态码、返回结构、算不出来时
    对读者说的话）。把 `_authorship_payload` 换成一个假的返回值来跑，
    免得为了验一句文案再掏十几秒。

**这里还有一条最要紧的断言：算完之后 data/raw 与 data/processed 一个字节都没动。**
作者归属号称「只读、不碰既有数值」，那是它敢加进这个项目的前提；不写下来，
下次谁顺手在中间加一句落盘，也不会有人发现。
"""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from src.authorship import (
    BUILTIN_AUTHORS,
    _delta,
    analyze,
    author_of,
    average_linkage,
    corpus_top_words,
    delta_matrix,
    leaf_order,
    standardize,
)

BASE_DIR = Path(__file__).resolve().parent.parent
RAW_DIR = BASE_DIR / "data" / "raw"
PROCESSED_DIR = BASE_DIR / "data" / "processed"


class AuthorMappingTestCase(unittest.TestCase):
    """书名 → 作者这张表本身。"""

    def test_four_builtin_books_have_authors(self):
        expected = {
            "The call of the wild": "London, Jack",
            "White Fang": "London, Jack",
            "The Adventures of Tom Sawyer": "Twain, Mark",
            "The Adventures of Huckleberry Finn": "Twain, Mark",
        }
        for title, author in expected.items():
            self.assertEqual(author_of(title)[0], author)
            self.assertEqual(author_of(title)[1], BUILTIN_AUTHORS[title.lower()][1])

    def test_lookup_ignores_case_and_surrounding_space(self):
        # 书单的兜底文案里把「The call of the wild」写成过「The Call of the Wild」，
        # 大小写不该让一条件专著条目凭空消失（前端那份表也是这么处理的）。
        self.assertEqual(author_of("  the CALL of the Wild ")[0], "London, Jack")

    def test_uploaded_book_has_no_author(self):
        # 用户上传的书没有可靠的作者，不能替他编一个。查不到就返回 (None, None)，
        # 调用方据此把它排除在作者层面的统计之外。
        self.assertEqual(author_of("My Essay Final v3"), (None, None))

    def test_non_string_input_is_safe(self):
        self.assertEqual(author_of(None), (None, None))
        self.assertEqual(author_of(123), (None, None))


class StandardizeTestCase(unittest.TestCase):
    """z 标准化：这是 Delta 里最容易做错、也最要紧的一步。"""

    def test_zero_variance_words_are_dropped(self):
        # 第二列在所有窗口里完全一样 → 它没有任何分辨力，必须被剔掉，
        # 否则只会把所有人的 Delta 一起压小。
        reference = np.array([[1.0, 5.0], [2.0, 5.0], [3.0, 5.0]])
        profiles = {"a": np.array([1.0, 5.0]), "b": np.array([3.0, 5.0])}
        z, keep, _mu, _sd = standardize(profiles, reference)
        self.assertEqual(int(keep.sum()), 1)
        self.assertEqual(z["a"].shape, (1,))

    def test_values_are_centered_and_scaled(self):
        reference = np.array([[1.0], [2.0], [3.0]])
        profiles = {"mid": np.array([2.0])}
        z, _keep, mu, sd = standardize(profiles, reference)
        self.assertAlmostEqual(float(mu[0]), 2.0)
        self.assertAlmostEqual(float(z["mid"][0]), 0.0)

    def test_far_away_profile_gets_large_positive_z(self):
        reference = np.array([[1.0], [2.0], [3.0]])
        profiles = {"high": np.array([9.0])}
        z, _keep, _mu, _sd = standardize(profiles, reference)
        self.assertGreater(float(z["high"][0]), 1.0)


class DeltaTestCase(unittest.TestCase):
    """Burrows' Delta 本身的几条性质。"""

    def test_delta_is_average_absolute_difference(self):
        a = np.array([0.0, 1.0, 2.0])
        b = np.array([1.0, 1.0, 4.0])
        self.assertAlmostEqual(_delta(a, b), (1.0 + 0.0 + 2.0) / 3.0)

    def test_delta_is_zero_for_identical_profiles(self):
        a = np.array([0.3, -1.2, 2.4])
        self.assertAlmostEqual(_delta(a, a), 0.0)

    def test_delta_is_symmetric(self):
        a, b = np.array([0.0, 1.0]), np.array([3.0, -1.0])
        self.assertAlmostEqual(_delta(a, b), _delta(b, a))

    def test_delta_matrix_diagonal_is_zero_and_symmetric(self):
        reference = np.array([[1.0, 2.0], [2.0, 4.0], [4.0, 8.0]])
        mats = {"a": reference, "b": reference * 0.5 + 0.1, "c": reference * 2.0}
        matrix, _z, _keep = delta_matrix(mats, ["a", "b", "c"])
        for i in range(3):
            self.assertEqual(matrix[i][i], 0.0)
            for j in range(3):
                self.assertAlmostEqual(matrix[i][j], matrix[j][i], places=9)


class AverageLinkageTestCase(unittest.TestCase):
    """层次聚类：用的是「两簇两两距离的平均」，不是「最近的一对」。"""

    # 这张矩阵是特意造的：单连接在第二步会把 C 并进来（{A,B}–C 最近的一对只有
    # 1.1），平均连接则会选 D（{A,B}–D 的两条距离都是 3，平均 3，比 C 的 5.55 近）。
    # 换句话说，下面这条断言一旦成立，就说明实现的确实是平均连接。
    MATRIX = [
        [0.0, 1.0, 1.1, 3.0],
        [1.0, 0.0, 10.0, 3.0],
        [1.1, 10.0, 0.0, 4.0],
        [3.0, 3.0, 4.0, 0.0],
    ]
    NAMES = ["A", "B", "C", "D"]

    def test_first_merge_is_the_closest_pair(self):
        merges = average_linkage(self.NAMES, self.MATRIX)
        self.assertEqual((merges[0]["left"], merges[0]["right"]), (0, 1))
        self.assertAlmostEqual(merges[0]["height"], 1.0)

    def test_second_merge_uses_average_not_single_link(self):
        merges = average_linkage(self.NAMES, self.MATRIX)
        # 平均连接：{A,B} 与 D 的平均距离 (3+3)/2 = 3，比 {A,B} 与 C 的 (1.1+10)/2 近
        self.assertAlmostEqual(merges[1]["height"], 3.0)
        self.assertIn("D", merges[1]["leaves"])
        self.assertNotIn("C", merges[1]["leaves"])

    def test_merge_count_and_final_height(self):
        merges = average_linkage(self.NAMES, self.MATRIX)
        self.assertEqual(len(merges), len(self.NAMES) - 1)   # n 个叶子合并 n-1 次
        self.assertEqual(merges[-1]["size"], len(self.NAMES))
        # 高度必须单调不减：一棵画得出来的树不能有「先高后低」的合并
        heights = [m["height"] for m in merges]
        self.assertEqual(heights, sorted(heights))

    def test_result_is_deterministic(self):
        first = average_linkage(self.NAMES, self.MATRIX)
        second = average_linkage(self.NAMES, self.MATRIX)
        self.assertEqual(first, second)

    def test_leaf_order_visits_every_leaf_once(self):
        merges = average_linkage(self.NAMES, self.MATRIX)
        order = leaf_order(merges, self.NAMES)
        self.assertEqual(sorted(order), sorted(self.NAMES))
        self.assertEqual(len(order), len(set(order)))

    def test_leaf_order_groups_merged_pairs_together(self):
        # A、B 先合并，所以在从左到右的顺序里必须相邻——否则图上同一支的书
        # 会被别的书隔开，看着别扭还容易读错。
        merges = average_linkage(self.NAMES, self.MATRIX)
        order = leaf_order(merges, self.NAMES)
        self.assertEqual(abs(order.index("A") - order.index("B")), 1)


class SyntheticCorpusTestCase(unittest.TestCase):
    """用一个自己造的极小语料，验「算不出来的那几种情况」不会硬画一张空图。"""

    def _write(self, tmp, name, text):
        path = Path(tmp) / (name + ".txt")
        path.write_text(text, encoding="utf-8")
        return path

    def test_single_book_is_not_enough(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._write(tmp, "only", "the cat sat on the mat " * 3000)
            result = analyze(tmp)
            self.assertFalse(result["enough"])
            self.assertIn("message", result)

    def test_books_without_known_authors_are_not_enough(self):
        # 两本书都查不到作者（用户上传的书就是这样）。距离矩阵算得出来，
        # 但「归属」没有可对答案的基准，所以整体判定为算不出来。
        with tempfile.TemporaryDirectory() as tmp:
            self._write(tmp, "one", "the cat sat on the mat and then the dog ran " * 2500)
            self._write(tmp, "two", "a dog ran and the cat sat while the mat stayed " * 2500)
            result = analyze(tmp)
            self.assertFalse(result["enough"])

    def test_empty_directory_is_not_enough(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(analyze(tmp)["enough"])


class CorpusTopWordsTestCase(unittest.TestCase):
    def test_returns_requested_count_in_frequency_order(self):
        blocks = {"x": ["the the the cat sat", "the mat sat on the mat"]}
        words = corpus_top_words(blocks, 3)
        self.assertEqual(len(words), 3)
        self.assertEqual(words[0], "the")          # 最高频的排在第一个

    def test_asking_for_more_than_exists_returns_what_there_is(self):
        blocks = {"x": ["alpha beta"]}
        self.assertEqual(sorted(corpus_top_words(blocks, 50)), ["alpha", "beta"])

    def test_empty_corpus_returns_empty_list(self):
        self.assertEqual(corpus_top_words({}, 10), [])


def _snapshot(directory):
    """目录下每个文件的内容摘要 + 修改时间，用来证明「算完什么都没动」。"""
    snap = {}
    for path in sorted(Path(directory).glob("**/*")):
        if not path.is_file():
            continue
        stat = path.stat()
        snap[str(path)] = (stat.st_mtime_ns, stat.st_size,
                           hashlib.sha256(path.read_bytes()).hexdigest())
    return snap


class AuthorshipRealCorpusTestCase(unittest.TestCase):
    """
    拿真实的四本内置书跑一遍完整分析。

    整份结果在 `setUpClass` 里只算一次（约十几秒），各条断言共用它——
    每条测试各算一遍的话，这一块会从十几秒涨到几分钟。
    """

    @classmethod
    def setUpClass(cls):
        cls.result = analyze(RAW_DIR)
        cls.names = cls.result["distance"]["names"]
        cls.matrix = cls.result["distance"]["matrix"]

    def test_enough_and_two_authors(self):
        self.assertTrue(self.result["enough"])
        self.assertEqual(len(self.result["books"]), 4)
        self.assertEqual(len(self.result["authors"]), 2)
        self.assertEqual({a["name"] for a in self.result["authors"]},
                         {"London, Jack", "Twain, Mark"})
        # 两位作者各两本——这正是让「作者归属」有答案可对的前提
        for author in self.result["authors"]:
            self.assertEqual(len(author["books"]), 2)

    def test_distance_matrix_shape_is_consistent(self):
        self.assertEqual(len(self.names), 4)
        for i, row in enumerate(self.matrix):
            self.assertEqual(len(row), 4)
            self.assertEqual(row[i], 0.0)
            for j in range(4):
                self.assertAlmostEqual(row[j], self.matrix[j][i], places=9)

    def test_distance_values_are_pinned(self):
        # 这四个数一旦变了，说明特征、归一化或标准化的某一环被改动了——
        # 而那意味着这个页签上说的所有话都要重新验一遍。所以钉住它们。
        expected = {
            ("The call of the wild", "White Fang"): 0.5937,
            ("The Adventures of Tom Sawyer", "The Adventures of Huckleberry Finn"): 0.7496,
            ("The Adventures of Tom Sawyer", "White Fang"): 0.8043,
        }
        for (a, b), value in expected.items():
            i, j = self.names.index(a), self.names.index(b)
            self.assertAlmostEqual(self.matrix[i][j], value, places=3,
                                   msg=f"{a} ↔ {b} 的 Delta 应该是 {value}")

    def test_same_author_books_are_always_closer(self):
        # 这是整个页签的立论基础，而且要说全：**最远的一对同作者书**
        # 也要比**最近的一对跨作者书**更近。只验「平均上更近」是不够的——
        # 要的是一条干净的界线，不是一次统计上的倾向。
        authors = {b["name"]: b["author"] for b in self.result["books"]}
        same, cross = [], []
        for i, a in enumerate(self.names):
            for j, b in enumerate(self.names):
                if i >= j:
                    continue
                (same if authors[a] == authors[b] else cross).append(
                    (self.matrix[i][j], f"{a} ↔ {b}"))
        self.assertTrue(same and cross)
        farthest_same = max(same)
        nearest_cross = min(cross)
        self.assertLess(farthest_same[0], nearest_cross[0],
                        msg=f"同作者最远的一对 {farthest_same[1]}（{farthest_same[0]:.4f}）"
                            f"没有近过跨作者最近的一对 {nearest_cross[1]}"
                            f"（{nearest_cross[0]:.4f}）——作者层面的界线不成立")

    def test_tree_merges_the_two_authors_last(self):
        merges = self.result["clustering"]["merges"]
        self.assertEqual(len(merges), 3)                     # 4 个叶子 → 3 次合并
        # 前两次合并各自只收同作者的两本
        for merge in merges[:2]:
            authors = {b["name"]: b["author"] for b in self.result["books"]}
            self.assertEqual(len({authors[n] for n in merge["leaves"]}), 1,
                             msg=f"这次合并不该跨作者：{merge['leaves']}")
        # 最后一次才把两位作者并到一起，而且高度必须明显更高
        self.assertGreater(merges[2]["height"], merges[1]["height"])

    def test_leaf_order_keeps_each_author_adjacent(self):
        order = self.result["clustering"]["leafOrder"]
        authors = {b["name"]: b["author"] for b in self.result["books"]}
        self.assertEqual(len(order), 4)
        # 同作者的两本在从左到右的顺序里必须挨着
        for author in {b["author"] for b in self.result["books"]}:
            positions = [order.index(n) for n in order if authors[n] == author]
            self.assertEqual(max(positions) - min(positions), 1)

    def test_leave_one_out_is_perfect_with_positive_margins(self):
        loo = self.result["leaveOneOut"]
        self.assertEqual(loo["total"], 4)
        self.assertEqual(loo["correct"], 4)
        for row in loo["rows"]:
            self.assertTrue(row["correct"], msg=f"{row['book']} 判错了")
            self.assertEqual(row["predictedAuthor"], row["author"])
            # 领先幅度必须为正，否则「判对」只是并列里的巧合
            self.assertGreater(row["margin"], 0.0)
            # 每本书都要把到其它三本的距离都报出来，读者才能自己复核
            self.assertEqual(len(row["distances"]), 3)

    def test_tom_sawyer_is_the_narrowest_win(self):
        # 这是这份数据里最该被读者看见的一条：吐温那两本相隔八年，
        # 《汤姆·索亚历险记》只领先第二名 0.057——判对了，但赢得不轻松。
        # 不把它写在测试里，界面上一不留神就会把它说成「铁证」。
        rows = {row["book"]: row for row in self.result["leaveOneOut"]["rows"]}
        margins = {name: row["margin"] for name, row in rows.items()}
        narrowest = min(margins, key=margins.get)
        self.assertEqual(narrowest, "The Adventures of Tom Sawyer")
        self.assertLess(margins[narrowest], 0.1)

    def test_block_attribution_uses_non_overlapping_windows(self):
        blocks = self.result["blockAttribution"]
        self.assertEqual(blocks["stride"], 10)
        self.assertGreater(blocks["total"], 0)
        # 总数必须等于「每本书每 10 个窗口取 1 个」之和，不能是全部窗口
        total_windows = sum(b["blocks"] for b in self.result["books"])
        self.assertLess(blocks["total"], total_windows / 5)
        self.assertEqual(blocks["correct"], sum(p["correct"] for p in blocks["perBook"]))

    def test_block_attribution_beats_chance_clearly(self):
        blocks = self.result["blockAttribution"]
        accuracy = blocks["accuracy"]
        self.assertIsNotNone(accuracy)
        # 抛硬币是 50%。这条留了很大的余量（实测 85.7%），
        # 因为它是「逐窗判定」而不是「逐书判定」，本来就该更难。
        self.assertGreater(accuracy, 0.7)

    def test_block_attribution_is_leave_one_out(self):
        """
        判定某个窗口时，被它所属的那本书**不参与定标**。

        这条不只钉住「口径是留一书」，还钉住一个实测事实：在这四本书上，换成
        「四本一起定标」的朴素口径，逐窗结论**一模一样**（同样 24/28、每一本的
        判对数也逐一相同）。所以这条测试的用法是双向的——将来有人把口径改回朴素、
        数字却没变，它不会响（那没关系，结论没变）；但一旦两者开始不一致，它就会
        在距离那一栏先响，提示「这次不一样了，得说清楚为什么」。
        """
        import numpy as np

        from src import authorship as A

        blocks = self.result["blockAttribution"]
        self.assertEqual((blocks["correct"], blocks["total"]), (24, 28))
        self.assertEqual([(p["book"], p["correct"], p["total"]) for p in blocks["perBook"]],
                         [("The Adventures of Huckleberry Finn", 11, 11),
                          ("The Adventures of Tom Sawyer", 4, 7),
                          ("The call of the wild", 3, 3),
                          ("White Fang", 6, 7)])

        # 朴素口径（四本一起定标，含被藏起来的那本）重算一遍，逐本对照
        names, blocks_by_book, _ = A.load_corpus_blocks(RAW_DIR)
        mats, _profiles, _vocab = A.book_matrices(blocks_by_book)
        usable = [n for n in names if n in mats]
        all_blocks = np.vstack([mats[n] for n in usable])
        profiles = {n: mats[n].mean(axis=0) for n in usable}
        z, keep, mu, sd = A.standardize(profiles, all_blocks)
        naive = {}
        for held in usable:
            train = [n for n in usable if n != held]
            true_author = A.author_of(held)[0]
            right = 0
            for row in mats[held][::blocks["stride"]][:, keep]:
                winner, _d, _ranked = A._nearest((row - mu) / sd, z, train)
                right += 1 if (true_author is not None
                               and A.author_of(winner)[0] == true_author) else 0
            naive[held] = right
        self.assertEqual(
            naive, {p["book"]: p["correct"] for p in blocks["perBook"]},
            msg="朴素定标与留一书定标这次不再给出相同的逐窗结论——"
                "得回去看看是不是改动碰坏了定标，并在文档里说清这次差在哪")

    def test_sensitivity_covers_every_vocabulary_and_stays_perfect_on_leave_one_out(self):
        rows = self.result["sensitivity"]
        self.assertEqual(len(rows), 5)
        labels = [r["label"] for r in rows]
        self.assertEqual(labels[0], "NLTK 英语停用词")
        self.assertEqual(len(set(labels)), len(labels))
        for row in rows:
            self.assertEqual(row["leaveOneOutCorrect"], row["leaveOneOutTotal"],
                             msg=f"{row['label']} 这档留一书没全对，结论就依赖参数了")
            self.assertGreater(row["vocabSize"], 0)
            self.assertGreater(row["comparableWords"], 0)
            self.assertLessEqual(row["comparableWords"], row["vocabSize"])

    def test_meta_describes_the_settings_actually_used(self):
        meta = self.result["meta"]
        self.assertEqual(meta["blockSize"], 10000)
        self.assertEqual(meta["overlap"], 9000)
        self.assertEqual(meta["stride"], 10)
        self.assertEqual(meta["vocabulary"], "NLTK 英语停用词")
        self.assertIn("Delta", meta["distance"])

    def test_payload_is_json_serialisable(self):
        # 接口直接把它 jsonify() 出去，任何 numpy 类型漏进来都会在线上炸。
        text = json.dumps(self.result, ensure_ascii=False)
        self.assertGreater(len(text), 500)

    def test_analysis_never_writes_to_disk(self):
        """
        最要紧的一条：算完之后 data/raw 与 data/processed 一个字节都没动。

        「只读、不碰既有数值」是作者归属能加进这个项目的前提。这不是一句保证，
        是一条断言——下次谁在中间顺手加一句落盘，这里会当场变红。
        """
        before_raw = _snapshot(RAW_DIR)
        before_processed = _snapshot(PROCESSED_DIR)

        analyze(RAW_DIR, sizes=())      # 不跑敏感性，几秒钟；跑的是同一条读写路径

        self.assertEqual(_snapshot(RAW_DIR), before_raw,
                         "分析过程改动了 data/raw 下的文件")
        self.assertEqual(_snapshot(PROCESSED_DIR), before_processed,
                         "分析过程往 data/processed 里写了东西")


class AuthorshipApiTestCase(unittest.TestCase):
    """
    只验接口接线。

    `_authorship_payload` 被换成假的返回值——真实计算要十几秒，而这里要验的
    是「状态码对不对、结构对不对、算不出来时对读者说的话对不对」，
    跟那十几秒没关系。真正的计算由上面的 RealCorpus 那块负责。
    """

    @classmethod
    def setUpClass(cls):
        import api_server
        cls.api = api_server
        cls.client = api_server.app.test_client()

    def test_returns_success_with_full_payload(self):
        fake = {"enough": True, "books": [{"name": "X"}], "meta": {}}
        with mock.patch.object(self.api, "_authorship_payload", return_value=fake):
            resp = self.client.get("/api/authorship")
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertEqual(body["status"], "success")
        self.assertEqual(body["data"], fake)

    def test_not_enough_data_is_404_with_reader_facing_message(self):
        fake = {"enough": False, "books": [], "message": "语料里至少要有两本书。"}
        with mock.patch.object(self.api, "_authorship_payload", return_value=fake):
            resp = self.client.get("/api/authorship")
        self.assertEqual(resp.status_code, 404)
        body = resp.get_json()
        self.assertEqual(body["status"], "error")
        self.assertEqual(body["message"], fake["message"])

    def test_missing_corpus_message_offers_no_impossible_next_step(self):
        # 算不出来时**不能**说「上传一本书就能用」——上传的书没有作者，
        # 本来就不参与这项分析。说了就是给读者指一条走不通的路。
        with mock.patch.object(self.api, "_authorship_payload", return_value=None):
            resp = self.client.get("/api/authorship")
        self.assertEqual(resp.status_code, 404)
        message = resp.get_json()["message"]
        self.assertNotIn("上传", message)
        for leak in ("python", "/api/", "generate_data", "None"):
            self.assertNotIn(leak, message)
        self.assertTrue(message.endswith("。"))

    def test_internal_error_is_500_without_leaking_details(self):
        # 顺带把 logger 静音：服务端本来就该记这条 traceback，但测试输出里
        # 混进一段「ERROR … boom」会让人以为这一跑挂了。
        with mock.patch.object(self.api, "_authorship_payload",
                               side_effect=RuntimeError("boom")), \
                mock.patch.object(self.api.app.logger, "exception"):
            resp = self.client.get("/api/authorship")
        self.assertEqual(resp.status_code, 500)
        body = resp.get_json()
        self.assertEqual(body["status"], "error")
        self.assertNotIn("boom", body["message"])

    def test_raw_stamp_changes_when_a_text_file_changes(self):
        # 缓存是按 data/raw 的指纹存的；指纹不跟着文件走的话，
        # 换了语料还在发旧结果，而这件事不会报错、只是数字悄悄过期。
        with tempfile.TemporaryDirectory() as tmp:
            original = self.api.DATA_DIR
            try:
                self.api.DATA_DIR = Path(tmp)
                self.assertEqual(self.api._raw_stamp(), ())
                (Path(tmp) / "a.txt").write_text("hello", encoding="utf-8")
                first = self.api._raw_stamp()
                self.assertEqual(len(first), 1)
                (Path(tmp) / "a.txt").write_text("hello world", encoding="utf-8")
                self.assertNotEqual(self.api._raw_stamp(), first)
            finally:
                self.api.DATA_DIR = original


if __name__ == "__main__":
    unittest.main()
