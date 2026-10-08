"""
「我的图书馆」API 单元测试
==========================
覆盖 api_server.py 中新增的书库能力：文件名清洗与命名去重、上传保存与替换、
书目 source 标记、指纹数据合并、删除保护（内置不可删 / 404 / CJK 路径）。

安全说明：全部通过 monkeypatch 把 BASE_DIR/DATA_DIR/LIBRARY_DIR 指到
临时目录（tempfile），**绝不触碰仓库内 data/raw、data/library 或 all_books.json**。
分析管线（get_blocks / build_book_data）用桩替代，避免真实跑 NLTK。

运行方式：
    python tests/test_api.py
或：
    python -m unittest discover -s tests -v
"""
import io
import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api_server  # noqa: E402
from api_server import MAX_BLOCKS  # noqa: E402

BUILTIN_NAME = "White Fang"

# 测试用的访客编号。真实运行时这枚编号由服务器随机签发（见 api_server._identify_visitor），
# 这里固定一个，好让「存进去的书」和「读出来的书」落在同一个书架目录里，且可以断言。
TEST_VISITOR = "testvisitor00000001"

# 模拟线上域名：删除保护的用例靠伪造 Host 头来区分「本机 / 线上」。
# 它同时决定了 cookie 归属哪个站点——换 Host 就是换站点，按 localhost 存的那枚带不过去。
REMOTE_HOST = "literature-fingerprinting.onrender.com"

# 结构与真实单书一致的最小桩（足够让路由/合并逻辑消费）。
# 注意 hapaxLegomena 是 Honoré R（量级 1700–2500，见 data/processed/all_books.json），
# 不是「只出现一次的词的个数」——写文案时别照这个桩的数值反推语义。
FAKE_BOOK = {
    "sentenceLength": [{"block": 0, "value": 1.0, "keywords": ["alpha"], "preview": "hello", "wordCount": 2}],
    "simpsonIndex": [{"block": 0, "value": 0.5, "keywords": ["alpha"], "preview": "hello", "wordCount": 2}],
    "hapaxLegomena": [{"block": 0, "value": 1905.89, "keywords": ["alpha"], "preview": "hello", "wordCount": 2}],
    "functionWords": [{"block": 0, "value": 0.0, "value_y": 0.0, "keywords": ["alpha"],
                       "preview": "hello", "extended_preview": "hello", "wordCount": 2}],
    "metadata": {"totalBlocks": 1, "totalWords": 2, "avgSentenceLength": 1.0, "avgSimpsonIndex": 0.5},
}


class TestSanitizeBookName(unittest.TestCase):
    """纯函数测试，不依赖目录。"""

    def test_plain_ascii_preserved(self):
        self.assertEqual(api_server.sanitize_book_name("Moby Dick"), "Moby Dick")

    def test_forbidden_chars_replaced_and_collapsed(self):
        self.assertEqual(api_server.sanitize_book_name(r"a/b\c*d?e"), "a_b_c_d_e")

    def test_edges_stripped(self):
        self.assertEqual(api_server.sanitize_book_name("  my novel  ."), "my novel")

    def test_cjk_and_fullwidth_parens_preserved(self):
        self.assertEqual(api_server.sanitize_book_name("白牙（我的）"), "白牙（我的）")

    def test_whitespace_control_removed_but_space_kept(self):
        self.assertEqual(api_server.sanitize_book_name("a\tb\nc d"), "abc d")
        self.assertEqual(api_server.sanitize_book_name("标题　副题"), "标题副题")

    def test_windows_reserved_device_name_prefixed(self):
        self.assertEqual(api_server.sanitize_book_name("CON"), "_CON")
        self.assertEqual(api_server.sanitize_book_name("com1"), "_com1")

    def test_empty_falls_back_to_book(self):
        self.assertEqual(api_server.sanitize_book_name(""), "book")
        self.assertEqual(api_server.sanitize_book_name(None), "book")
        self.assertEqual(api_server.sanitize_book_name("   "), "book")

    def test_capped_at_200(self):
        self.assertEqual(len(api_server.sanitize_book_name("x" * 300)), 200)


class TestResolveFinalName(unittest.TestCase):
    """命名去重：书库替换 > 内置加后缀 > 原样。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.library = Path(self._tmp.name) / "library"
        self.raw = Path(self._tmp.name) / "raw"
        self.library.mkdir()
        self.raw.mkdir()
        (self.raw / f"{BUILTIN_NAME}.txt").write_text("x", encoding="utf-8")
        self._patches = [
            mock.patch.object(api_server, "LIBRARY_DIR", self.library),
            mock.patch.object(api_server, "DATA_DIR", self.raw),
        ]
        for p in self._patches:
            p.start()
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def _put_library(self, name):
        (self.library / f"{name}.json").write_text("{}", encoding="utf-8")

    def test_builtin_collision_gets_mypostfix(self):
        self.assertEqual(api_server._resolve_final_name(BUILTIN_NAME), f"{BUILTIN_NAME}（我的）")

    def test_builtin_collision_escalates_when_postfix_taken(self):
        self._put_library(f"{BUILTIN_NAME}（我的）")
        self.assertEqual(api_server._resolve_final_name(BUILTIN_NAME), f"{BUILTIN_NAME}（我的）(2)")

    def test_existing_library_name_replaces_in_place(self):
        self._put_library("Alice")
        self.assertEqual(api_server._resolve_final_name("Alice"), "Alice")

    def test_fresh_name_kept(self):
        self.assertEqual(api_server._resolve_final_name("Moby Dick"), "Moby Dick")


def stub_block_count(n_blocks=2):
    """
    把上传路径里「这段文本会切出几个片段」这一步打桩。

    片段数现在由 count_blocks 纯算术算出（第三十批：真的去切一份 20 MB 文本要
    2 秒、峰值 415 MB，而那么大的文本无论切不切都会被上限拒掉），所以只打桩
    get_blocks 已经不够——不打桩 count_blocks 的话，那些拿一句「content」当正文的
    用例会先被长度闸门拦下，走不到真正被测的那个分支。
    """
    return mock.patch("src.data_loader.count_blocks", return_value=n_blocks)


class LibraryApiTestCase(unittest.TestCase):
    """Flask test_client 场景测试（全临时目录）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.raw = root / "data" / "raw"
        self.processed = root / "data" / "processed"
        self.library = root / "data" / "library"
        self.raw.mkdir(parents=True)
        self.processed.mkdir(parents=True)
        self.library.mkdir(parents=True)
        # 书架的真正落盘位置：LIBRARY_DIR 下面按访客编号分的一格
        self.shelf = self.library / TEST_VISITOR

        (self.raw / f"{BUILTIN_NAME}.txt").write_text("builtin content. " * 30, encoding="utf-8")
        (self.processed / "all_books.json").write_text(
            json.dumps({BUILTIN_NAME: FAKE_BOOK}, ensure_ascii=False), encoding="utf-8"
        )

        self._patches = [
            mock.patch.object(api_server, "BASE_DIR", root),
            mock.patch.object(api_server, "DATA_DIR", self.raw),
            mock.patch.object(api_server, "LIBRARY_DIR", self.library),
            mock.patch.object(api_server, "_ensure_demo_data", lambda: True),
        ]
        for p in self._patches:
            p.start()
        self.addCleanup(self._cleanup)

        api_server.app.config["TESTING"] = True
        self.client = api_server.app.test_client()
        # 书架按访客编号分目录：客户端带上固定的编号，请求才会落在 self.shelf 里。
        # 不带上也不是错——服务器会给一个新编号——但那样每请求换一格，存了就读不回来。
        # 两个域名各存一枚同号的：删除保护的用例会伪造 Host 头，那是另一个站点，
        # 按 localhost 存的那枚带不过去。
        self.client.set_cookie(api_server.VISITOR_COOKIE, TEST_VISITOR)
        self.client.set_cookie(api_server.VISITOR_COOKIE, TEST_VISITOR, domain=REMOTE_HOST)
        # 限流是进程级的：不清理的话，用例一多就会互相拖累（后跑的用例收到 429）
        api_server._rate_state.clear()

    def _cleanup(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def _put_library(self, name, payload=None):
        self.shelf.mkdir(parents=True, exist_ok=True)
        target = self.shelf / f"{name}.json"
        target.write_text(json.dumps(payload if payload is not None else FAKE_BOOK, ensure_ascii=False),
                          encoding="utf-8")
        return target

    def _post_analyze(self, filename, content=b"content", save=True, client=None):
        """带桩地走 /api/analyze：不做真实 NLTK 分析。"""
        with stub_block_count(2), \
             mock.patch("src.data_loader.get_blocks", return_value=["alpha", "beta"]), \
             mock.patch("src.pipeline.build_book_data", return_value=FAKE_BOOK):
            data = {"file": (io.BytesIO(content), filename)}
            if save:
                data["save"] = "1"
            return (client or self.client).post("/api/analyze", data=data,
                                                content_type="multipart/form-data")

    def _another_visitor(self, visitor):
        """再开一个「浏览器」：另一个客户端，另一个访客编号。"""
        client = api_server.app.test_client()
        client.set_cookie(api_server.VISITOR_COOKIE, visitor)
        client.set_cookie(api_server.VISITOR_COOKIE, visitor, domain=REMOTE_HOST)
        return client

    # ---- /api/books ----
    def test_books_mark_builtin_then_library(self):
        self._put_library("Alice")
        self._put_library("Alice2")
        resp = self.client.get("/api/books")
        self.assertEqual(resp.status_code, 200)
        books = resp.get_json()["books"]
        by_id = {b["id"]: b for b in books}
        self.assertEqual(by_id[BUILTIN_NAME]["source"], "builtin")
        self.assertEqual(by_id["Alice"]["source"], "library")
        self.assertEqual(by_id["Alice2"]["source"], "library")
        # 库书排在示例书之后，且不重复列出内置
        ids = [b["id"] for b in books]
        self.assertEqual(ids.index(BUILTIN_NAME), 0)
        self.assertGreater(ids.index("Alice"), ids.index(BUILTIN_NAME))
        self.assertEqual(len([b for b in books if b["id"] == BUILTIN_NAME]), 1)

    # ---- /api/analyze ----
    def test_analyze_save_persists_and_resolves_builtin_collision(self):
        resp = self._post_analyze(f"{BUILTIN_NAME}.txt")
        result = resp.get_json()
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["book"], f"{BUILTIN_NAME}（我的）")
        self.assertTrue(result["saved"])
        self.assertEqual(result["storage"], "local-library")  # test client host 为 localhost
        self.assertTrue((self.shelf / f"{BUILTIN_NAME}（我的）.json").exists())
        # 内置原始文件未被覆盖
        self.assertTrue((self.raw / f"{BUILTIN_NAME}.txt").exists())

    def test_analyze_without_save_does_not_persist(self):
        resp = self._post_analyze("MyDoc.txt", save=False)
        result = resp.get_json()
        self.assertEqual(result["status"], "success")
        self.assertFalse(result["saved"])
        self.assertNotIn("storage", result)
        self.assertEqual(list(self.shelf.glob("*.json")), [])

    def test_analyze_same_name_twice_replaces_single_file(self):
        self._post_analyze("MyDoc.txt")
        self._post_analyze("MyDoc.txt")
        files = list(self.shelf.glob("*.json"))
        self.assertEqual([f.name for f in files], ["MyDoc.json"])

    # ---- /api/fingerprint-data 合并 ----
    def test_fingerprint_merges_library_only_when_absent(self):
        self._put_library("Alice")
        # 与内置同名的书库文件不应覆盖内置数据
        self._put_library(BUILTIN_NAME, {"metadata": {}, "sentenceLength": []})
        # 损坏文件应被跳过，不影响其余合并
        (self.shelf / "Bad.json").write_text("not-json{{{", encoding="utf-8")

        resp = self.client.get("/api/fingerprint-data")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()["data"]
        # 内置键仍是 all_books.json 的数值 1.0，而非书库同名空数据
        self.assertEqual(data[BUILTIN_NAME]["sentenceLength"][0]["value"], 1.0)
        self.assertEqual(data["Alice"]["metadata"]["totalBlocks"], 1)
        self.assertNotIn("Bad", data)

    def test_fingerprint_no_processed_data_returns_404(self):
        (self.processed / "all_books.json").unlink()
        resp = self.client.get("/api/fingerprint-data")
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.get_json()["status"], "error")

    # ---- DELETE /api/library/<name> ----
    def test_delete_library_book(self):
        # 本机也要令牌（默认），这里模拟「保存它的那个浏览器」带着令牌来删
        self._put_library("Alice", dict(FAKE_BOOK, _deleteToken="tok-alice"))
        resp = self.client.delete("/api/library/Alice", headers={"X-Delete-Token": "tok-alice"})
        self.assertEqual(resp.status_code, 200)
        self.assertFalse((self.shelf / "Alice.json").exists())
        # 二次删除 → 404
        resp2 = self.client.delete("/api/library/Alice", headers={"X-Delete-Token": "tok-alice"})
        self.assertEqual(resp2.status_code, 404)

    def test_delete_builtin_is_rejected(self):
        resp = self.client.delete(f"/api/library/{BUILTIN_NAME}")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("内置示例书不能删除", resp.get_json()["message"])

    def test_delete_cjk_library_book(self):
        self._put_library("实验（我的）", dict(FAKE_BOOK, _deleteToken="tok-cjk"))
        path = "/api/library/" + quote("实验（我的）")
        resp = self.client.delete(path, headers={"X-Delete-Token": "tok-cjk"})
        self.assertEqual(resp.status_code, 200)
        self.assertFalse((self.shelf / "实验（我的）.json").exists())


class VisitorIsolationTestCase(LibraryApiTestCase):
    """
    每人一个书架：别人存的书，你既看不见、也删不掉、更不会进到你自己的图里。

    不做账号，靠的是一枚存在浏览器里的随机编号（api_server._identify_visitor）。
    """

    OTHER_VISITOR = "othervisitor00000002"

    def test_first_request_hands_out_a_visitor_cookie(self):
        client = api_server.app.test_client()
        resp = client.get("/api/books")
        self.assertEqual(resp.status_code, 200)
        self.assertIn(f"{api_server.VISITOR_COOKIE}=", resp.headers.get("Set-Cookie", ""))
        # 编号发一次就够：第二趟不该再回设
        again = client.get("/api/books")
        self.assertNotIn(api_server.VISITOR_COOKIE, again.headers.get("Set-Cookie", ""))
        # 第二趟请求带回去的，正是第一趟发下来的那枚编号
        handed = resp.headers["Set-Cookie"].split(";")[0]  # lf_visitor=xxxx
        self.assertIn(handed, again.request.headers.get("Cookie", ""))

    def test_books_and_corpus_are_per_visitor(self):
        self._put_library("Alice")
        other = self._another_visitor(self.OTHER_VISITOR)

        mine = {b["id"] for b in self.client.get("/api/books").get_json()["books"]}
        theirs = {b["id"] for b in other.get("/api/books").get_json()["books"]}
        self.assertIn("Alice", mine)
        self.assertNotIn("Alice", theirs)
        self.assertIn(BUILTIN_NAME, theirs, "内置示例书是所有人共用的")

        self.assertIn("Alice", self.client.get("/api/fingerprint-data").get_json()["data"])
        self.assertNotIn("Alice", other.get("/api/fingerprint-data").get_json()["data"])

    def test_library_book_data_is_not_reachable_by_others(self):
        self._put_library("Alice")
        other = self._another_visitor(self.OTHER_VISITOR)
        self.assertEqual(self.client.get("/api/book/Alice").status_code, 200)
        self.assertEqual(other.get("/api/book/Alice").status_code, 404)

    def test_cannot_delete_another_visitors_book(self):
        self._put_library("Alice", dict(FAKE_BOOK, _deleteToken="tok-alice"))
        other = self._another_visitor(self.OTHER_VISITOR)
        # 连删除令牌一起带上也删不掉：这本书根本不在他的书架上
        resp = other.delete("/api/library/Alice", headers={"X-Delete-Token": "tok-alice"})
        self.assertEqual(resp.status_code, 404)
        self.assertTrue((self.shelf / "Alice.json").exists())

    def test_same_name_can_live_on_two_shelves(self):
        self._put_library("MyDoc")
        other = self._another_visitor(self.OTHER_VISITOR)
        result = self._post_analyze("MyDoc.txt", client=other).get_json()
        # 甲先占了 MyDoc，不影响乙：乙存下来还是 MyDoc，不会变成 MyDoc（我的）(2)，
        # 也不会把甲那份整份换掉
        self.assertEqual(result["book"], "MyDoc")
        self.assertFalse(result.get("replacedExisting"))
        self.assertTrue((self.shelf / "MyDoc.json").exists())
        self.assertTrue((self.library / self.OTHER_VISITOR / "MyDoc.json").exists())

    def test_another_visitors_book_never_enters_your_corpus(self):
        other = self._another_visitor(self.OTHER_VISITOR)
        etag = other.get("/api/fingerprint-data").headers["ETag"]
        self._put_library("Alice")  # 甲存了一本书，乙那边什么都没变
        resp = other.get("/api/fingerprint-data", headers={"If-None-Match": etag})
        # 乙的内容确实一点没变，304 是对的。这一条专钉「书架指纹必须按访客取」：
        # 若指纹又变回「扫全库」，甲的保存会把乙的 ETag 一起改掉，这里就会变成 200。
        self.assertEqual(resp.status_code, 304)
        self.assertEqual(other.get("/api/book/Alice").status_code, 404)

    def test_forged_visitor_cookie_cannot_escape_the_library_dir(self):
        """伪造的编号只有一种下场：当成没有编号，另发一枚；绝不用它去拼路径。"""
        root = Path(self._tmp.name)
        for bad in ["../../escaped", "..", ".", "short", "with/slash", "a" * 200]:
            with self.subTest(cookie=bad):
                client = api_server.app.test_client()
                client.set_cookie(api_server.VISITOR_COOKIE, bad)
                resp = self._post_analyze("MyDoc.txt", client=client)
                self.assertEqual(resp.status_code, 200)
                # 服务器另发了一枚合法编号
                self.assertIn(f"{api_server.VISITOR_COOKIE}=", resp.headers.get("Set-Cookie", ""))
        # 落盘只可能落在 data/library/ 下面，外面一个目录都没多出来
        self.assertFalse((root / "escaped").exists())
        self.assertFalse((root.parent / "escaped").exists())
        saved = list((root / "data" / "library").rglob("MyDoc.json"))
        self.assertEqual(len(saved), len(["../../escaped", "..", ".", "short", "with/slash", "a" * 200]))
        for path in saved:
            self.assertEqual(path.parent.parent, root / "data" / "library")


class ShelfClaimTestCase(LibraryApiTestCase):
    """
    书架找回（POST /api/shelf/claim）与编号下发（/api/books 的 shelfCode）。

    这是全站唯一一条「客户端给的字符串 → 身份」的入口（此前身份只有 cookie 一条路），
    所以**失败路径比成功路径重要**：每一条失败都必须原地不动——不换身份、不回设 cookie、
    不建目录。成功路径则要证明「找回」是完整的：看得到、进得了自己的图、删得掉。
    """

    CLAIM = "/api/shelf/claim"
    HEADERS = {"X-Shelf-Claim": "1"}
    OTHER_VISITOR = "othervisitor00000002"

    def _claim(self, code, client=None, headers=None):
        return (client or self.client).post(
            self.CLAIM, json={"code": code},
            headers=self.HEADERS if headers is None else headers,
        )

    def _shelf_dirs(self):
        return sorted(p.name for p in self.library.iterdir() if p.is_dir())

    def _put_other_library(self, visitor, name, payload=None):
        """写进**别人**那一格（认领用例要有一个「别人的书架」可认领）。"""
        shelf = self.library / visitor
        shelf.mkdir(parents=True, exist_ok=True)
        target = shelf / f"{name}.json"
        target.write_text(json.dumps(payload if payload is not None else FAKE_BOOK, ensure_ascii=False),
                          encoding="utf-8")
        return target

    # ---- 编号下发 ----
    def test_books_response_carries_the_shelf_code(self):
        # cookie 是 HttpOnly，JS 读不到 document.cookie——这是全站唯一一条把编号
        # 交给前端的路，「书架编号」弹窗没有它就没东西可显示
        self.assertEqual(self.client.get("/api/books").get_json()["shelfCode"], TEST_VISITOR)

    def test_first_visit_shelf_code_matches_the_handed_cookie(self):
        client = api_server.app.test_client()
        resp = client.get("/api/books")
        handed = resp.headers["Set-Cookie"].split(";")[0].split("=", 1)[1]
        self.assertEqual(resp.get_json()["shelfCode"], handed)

    def test_shelf_code_is_not_a_token_leak(self):
        """新字段只带编号：删除令牌绝不许搭这次顺风车。"""
        self._put_library("Alice", dict(FAKE_BOOK, _deleteToken="tok-alice"))
        for url in ["/api/books", "/api/fingerprint-data", "/api/book/Alice"]:
            with self.subTest(url=url):
                body = self.client.get(url).get_data(as_text=True)
                self.assertNotIn("_deleteToken", body)
                self.assertNotIn("tok-alice", body)

    # ---- 认领：成功路径 ----
    def test_claim_hands_over_the_shelf_and_its_tokens(self):
        self._put_library("Alice", dict(FAKE_BOOK, _deleteToken="tok-alice"))
        self._put_library("Bob", dict(FAKE_BOOK, _deleteToken="tok-bob"))
        fresh = api_server.app.test_client()   # 另一台设备：还没拿到任何编号

        resp = self._claim(TEST_VISITOR, client=fresh)
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertEqual(body["status"], "success")
        self.assertEqual(body["shelfCode"], TEST_VISITOR)
        self.assertEqual({b["name"]: b["deleteToken"] for b in body["books"]},
                         {"Alice": "tok-alice", "Bob": "tok-bob"})
        # 切身份的响应绝不能进任何缓存
        self.assertIn("no-store", resp.headers.get("Cache-Control", ""))
        # 身份走的是首次发牌那条统一下发的路，属性一模一样
        cookie = resp.headers.get("Set-Cookie", "")
        self.assertIn(f"{api_server.VISITOR_COOKIE}={TEST_VISITOR}", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Lax", cookie)

        # 认领之后真的就是那一格：书单看得到、取得到、用交回的令牌删得掉
        listing = fresh.get("/api/books").get_json()
        self.assertEqual(listing["shelfCode"], TEST_VISITOR)
        self.assertIn("Alice", {b["id"] for b in listing["books"]})
        self.assertEqual(fresh.get("/api/book/Alice").status_code, 200)
        deleted = fresh.delete("/api/library/Alice", headers={"X-Delete-Token": "tok-alice"})
        # 这条断言是整个令牌交接的意义所在：只交编号的话，找回后能看不能删
        self.assertEqual(deleted.status_code, 200)
        self.assertFalse((self.shelf / "Alice.json").exists())
        self.assertTrue((self.shelf / "Bob.json").exists())

    def test_claimed_shelf_joins_your_corpus(self):
        other = self._another_visitor(self.OTHER_VISITOR)
        self._put_library("Alice")
        self.assertNotIn("Alice", other.get("/api/fingerprint-data").get_json()["data"])
        self.assertEqual(self._claim(TEST_VISITOR, client=other).status_code, 200)
        self.assertIn("Alice", other.get("/api/fingerprint-data").get_json()["data"])

    def test_shelf_without_tokens_still_claims(self):
        """旧版遗留的书没有令牌：认领要成功，只是「暂时删不掉」——不能因此整条失败。"""
        self._put_library("Alice")
        body = self._claim(TEST_VISITOR, client=api_server.app.test_client()).get_json()
        self.assertEqual(body["status"], "success")
        self.assertEqual(body["books"], [])

    def test_you_can_switch_back_and_forth(self):
        self._put_library("Mine")
        self._put_other_library(self.OTHER_VISITOR, "Theirs")
        client = api_server.app.test_client()

        self.assertEqual(self._claim(self.OTHER_VISITOR, client=client).status_code, 200)
        ids = {b["id"] for b in client.get("/api/books").get_json()["books"]}
        self.assertIn("Theirs", ids)
        self.assertNotIn("Mine", ids)

        self.assertEqual(self._claim(TEST_VISITOR, client=client).status_code, 200)
        ids = {b["id"] for b in client.get("/api/books").get_json()["books"]}
        self.assertIn("Mine", ids)
        self.assertNotIn("Theirs", ids)

    # ---- 认领：失败路径（每一条都必须原地不动）----
    def test_claim_without_the_custom_header_is_403(self):
        """没有自定义头的跨站表单 POST 打不到这里——防的是「登录型 CSRF」。"""
        self._put_other_library(self.OTHER_VISITOR, "Alice")
        resp = self.client.post(self.CLAIM, json={"code": self.OTHER_VISITOR})
        self.assertEqual(resp.status_code, 403)
        self.assertNotIn(api_server.VISITOR_COOKIE, resp.headers.get("Set-Cookie", ""))
        # 身份一点没动：还是自己那一格，看不到别人的书
        listing = self.client.get("/api/books").get_json()
        self.assertEqual(listing["shelfCode"], TEST_VISITOR)
        self.assertNotIn("Alice", {b["id"] for b in listing["books"]})

    def test_malformed_code_is_400_and_touches_nothing(self):
        root = Path(self._tmp.name)
        before = self._shelf_dirs()
        for bad in ["", "   ", None, "short", "../../escaped", "with space", "a" * 200]:
            with self.subTest(code=bad):
                resp = self._claim(bad)
                self.assertEqual(resp.status_code, 400)
                self.assertIn("格式不对", resp.get_json()["message"])
                self.assertNotIn(api_server.VISITOR_COOKIE, resp.headers.get("Set-Cookie", ""))
        # 校验发生在拼路径之前：伪造值什么都建不出来
        self.assertFalse((root / "escaped").exists())
        self.assertEqual(self._shelf_dirs(), before)

    def test_unknown_code_is_404_and_creates_nothing(self):
        before = self._shelf_dirs()
        resp = self._claim("nosuchvisitor00000001")
        self.assertEqual(resp.status_code, 404)
        self.assertIn("没有书架", resp.get_json()["message"])
        self.assertNotIn(api_server.VISITOR_COOKIE, resp.headers.get("Set-Cookie", ""))
        # 绝不 mkdir：否则随机编号能把服务器刷出一地空目录
        self.assertEqual(self._shelf_dirs(), before)

    def test_empty_shelf_dir_is_404_not_a_new_shelf(self):
        (self.library / "emptyvisitor00000001").mkdir()
        resp = self._claim("emptyvisitor00000001")
        # 目录在、但一本书都没有：与目录不存在同待遇（用户视角都是「没有书」）
        self.assertEqual(resp.status_code, 404)
        self.assertNotIn(api_server.VISITOR_COOKIE, resp.headers.get("Set-Cookie", ""))
        self.assertEqual(self.client.get("/api/books").get_json()["shelfCode"], TEST_VISITOR)

    def test_claim_lists_only_the_shelf_that_was_claimed(self):
        self._put_library("Mine", dict(FAKE_BOOK, _deleteToken="tok-mine"))
        self._put_other_library(self.OTHER_VISITOR, "Theirs", dict(FAKE_BOOK, _deleteToken="tok-theirs"))
        body = self._claim(TEST_VISITOR).get_json()
        self.assertEqual([b["name"] for b in body["books"]], ["Mine"])
        self.assertNotIn("Theirs", resp_text := json.dumps(body, ensure_ascii=False))
        self.assertNotIn("tok-theirs", resp_text)

    def test_claiming_your_own_code_is_fine(self):
        """认领自己正在用的编号：幂等成功，不是错误（用户可能只是想再确认一下）。"""
        self._put_library("Mine")
        resp = self._claim(TEST_VISITOR)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["shelfCode"], TEST_VISITOR)

    def test_stray_files_do_not_count_as_a_shelf(self):
        """「有没有书」只看 *.json：目录里躺着别的文件仍然是「这个编号下没有书架」。"""
        shelf = self.library / "strayvisitor0000001"
        shelf.mkdir()
        (shelf / "notes.txt").write_text("hello", encoding="utf-8")
        resp = self._claim("strayvisitor0000001")
        self.assertEqual(resp.status_code, 404)

    def test_a_file_where_the_shelf_dir_would_be_does_not_crash(self):
        """磁盘上那个位置是文件而不是目录：404，不是 500（glob 一个文件会抛异常）。"""
        (self.library / "filevisitor00000001").write_text("not a dir", encoding="utf-8")
        resp = self._claim("filevisitor00000001")
        self.assertEqual(resp.status_code, 404)
        self.assertNotIn(api_server.VISITOR_COOKIE, resp.headers.get("Set-Cookie", ""))

    def test_claim_is_rate_limited_and_stops(self):
        statuses = [self._claim(f"nosuchvisitor0000000{i}").status_code for i in range(12)]
        self.assertEqual(statuses[0], 404)
        self.assertEqual(statuses[-1], 429)
        self.assertIn("太频繁", self._claim("nosuchvisitor00000099").get_json()["message"])

    def test_claim_bucket_does_not_eat_the_upload_quota(self):
        """单独一个桶：几次认领不能把上传额度挤掉（否则找回一次就没法传书了）。"""
        for i in range(12):
            self._claim(f"nosuchvisitor0000000{i}")
        self.assertEqual(self._post_analyze("MyDoc.txt").status_code, 200)

    # ---- 空目录回收 ----
    def test_deleting_the_last_book_removes_the_empty_shelf_dir(self):
        self._put_library("Alice", dict(FAKE_BOOK, _deleteToken="tok-a"))
        self._put_library("Bob", dict(FAKE_BOOK, _deleteToken="tok-b"))
        self.client.delete("/api/library/Alice", headers={"X-Delete-Token": "tok-a"})
        self.assertTrue(self.shelf.exists(), "还有一本书，这一格必须在")
        self.client.delete("/api/library/Bob", headers={"X-Delete-Token": "tok-b"})
        self.assertFalse(self.shelf.exists(), "最后一本删掉后空目录一并收掉")
        self.assertTrue(self.library.exists(), "收的是自己那一格，LIBRARY_DIR 本身不动")

    def test_cleanup_leaves_other_shelves_alone(self):
        self._put_library("Mine", dict(FAKE_BOOK, _deleteToken="tok-mine"))
        other_book = self._put_other_library(self.OTHER_VISITOR, "Theirs")
        self.client.delete("/api/library/Mine", headers={"X-Delete-Token": "tok-mine"})
        self.assertFalse(self.shelf.exists())
        self.assertTrue(other_book.exists(), "别人那一格一个字节都不许动")


class LegacyLibraryTestCase(LibraryApiTestCase):
    """老版本（v1）书库文件：只做内存兼容，绝不改写磁盘上的旧文件。"""

    # v1 的 totalWords 其实是重叠窗口的词次累加（虚高近十倍），不能当成真实词数
    V1_BOOK = {
        "sentenceLength": [{"block": 0, "value": 2.5, "keywords": ["alpha"], "preview": "hello", "wordCount": 2}],
        "simpsonIndex": [{"block": 0, "value": 0.5, "keywords": ["alpha"], "preview": "hello", "wordCount": 2}],
        "hapaxLegomena": [{"block": 0, "value": 1905.89, "keywords": ["alpha"], "preview": "hello", "wordCount": 2}],
        "functionWords": [{"block": 0, "value": 0.1, "value_y": -0.1, "keywords": ["alpha"],
                           "preview": "hello", "extended_preview": "hello", "wordCount": 2}],
        "metadata": {"totalBlocks": 1, "totalWords": 1020000, "avgSentenceLength": 2.5, "avgSimpsonIndex": 0.5},
    }

    def test_v1_library_book_is_merged_and_listed(self):
        self._put_library("Old Novel", self.V1_BOOK)
        resp = self.client.get("/api/fingerprint-data")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()["data"]
        self.assertIn("Old Novel", data)
        self.assertEqual(data["Old Novel"]["sentenceLength"][0]["value"], 2.5)

    def test_v1_file_on_disk_is_not_rewritten(self):
        """兼容升级只发生在浏览器内存里，服务器不能偷偷改用户的老文件。"""
        target = self._put_library("Old Novel", self.V1_BOOK)
        before = target.read_bytes()

        self.client.get("/api/fingerprint-data")
        self.client.get("/api/books")

        self.assertEqual(target.read_bytes(), before)
        # 磁盘上仍然是 v1：没有 schemaVersion，也没有被补上 channels 之类的字段
        on_disk = json.loads(target.read_text(encoding="utf-8"))
        self.assertNotIn("schemaVersion", on_disk["metadata"])
        self.assertEqual(on_disk["metadata"]["totalWords"], 1020000)

    def test_v1_book_keeps_its_own_coordinates_flag(self):
        """没有 projection 元信息 = 老坐标，前端据此标「独立坐标·不可直接比较」。"""
        self._put_library("Old Novel", self.V1_BOOK)
        data = self.client.get("/api/fingerprint-data").get_json()["data"]
        self.assertNotIn("projection", data["Old Novel"]["metadata"])


class DeleteProtectionTestCase(LibraryApiTestCase):
    """删除保护：非本机访问必须带上保存时签发的删除令牌。"""

    REMOTE = {"Host": REMOTE_HOST}

    def test_nonlocal_delete_without_token_is_rejected(self):
        target = self._put_library("Alice")
        resp = self.client.delete("/api/library/Alice", headers=self.REMOTE)
        self.assertEqual(resp.status_code, 403)
        self.assertTrue(target.exists())
        self.assertIn("只有保存这本书的浏览器", resp.get_json()["message"])

    def test_nonlocal_delete_with_wrong_token_is_rejected(self):
        target = self._put_library("Alice", dict(FAKE_BOOK, _deleteToken="right-token"))
        resp = self.client.delete("/api/library/Alice", headers=dict(self.REMOTE, **{"X-Delete-Token": "wrong-token"}))
        self.assertEqual(resp.status_code, 403)
        self.assertTrue(target.exists())

    def test_nonlocal_delete_without_stored_token_is_rejected(self):
        """老文件里没有令牌 —— 一律不允许从远端删除，宁可让用户重传一份。"""
        target = self._put_library("Alice")
        resp = self.client.delete("/api/library/Alice",
                                  headers=dict(self.REMOTE, **{"X-Delete-Token": "any"}))
        self.assertEqual(resp.status_code, 403)
        self.assertTrue(target.exists())

    def test_saved_book_can_be_deleted_remotely_with_its_token(self):
        resp = self._post_analyze("MyDoc.txt")
        token = resp.get_json()["deleteToken"]
        self.assertTrue(token)

        # 令牌随书落盘，保存它的浏览器下次还拿得到
        stored = json.loads((self.shelf / "MyDoc.json").read_text(encoding="utf-8"))
        self.assertEqual(stored["_deleteToken"], token)

        resp = self.client.delete("/api/library/MyDoc",
                                  headers=dict(self.REMOTE, **{"X-Delete-Token": token}))
        self.assertEqual(resp.status_code, 200)
        self.assertFalse((self.shelf / "MyDoc.json").exists())

    def test_localhost_delete_needs_token_by_default(self):
        """
        本机默认也要令牌：Host 头是客户端说了算的，拿它当删除授权等于没授权。

        浏览器里正常删书走的是「保存时存下的令牌」那条路（前端 localStorage），
        所以这个默认值不影响日常使用，只是不再允许「谁都能删」。
        """
        target = self._put_library("Alice", dict(FAKE_BOOK, _deleteToken="right-token"))
        resp = self.client.delete("/api/library/Alice")
        self.assertEqual(resp.status_code, 403)
        self.assertTrue(target.exists())
        # 本机文案要和远程区分开：得告诉使用者怎么把文件删掉
        message = resp.get_json()["message"]
        self.assertIn("本机删除也需要保存时签发的令牌", message)
        self.assertIn("ALLOW_LOCAL_DELETE=1", message)

    def test_localhost_delete_with_its_token_works(self):
        """日常路径：本浏览器存过的书，用 localStorage 里的令牌照常删掉。"""
        self._put_library("Alice", dict(FAKE_BOOK, _deleteToken="right-token"))
        resp = self.client.delete("/api/library/Alice", headers={"X-Delete-Token": "right-token"})
        self.assertEqual(resp.status_code, 200)
        self.assertFalse((self.shelf / "Alice.json").exists())

    def test_localhost_delete_without_token_when_explicitly_allowed(self):
        """显式开关：ALLOW_LOCAL_DELETE=1 时本机才免令牌（默认关闭）。"""
        self._put_library("Alice")
        with mock.patch.dict(os.environ, {"ALLOW_LOCAL_DELETE": "1"}):
            resp = self.client.delete("/api/library/Alice")
        self.assertEqual(resp.status_code, 200)

    def test_local_delete_switch_does_not_open_remote_deletion(self):
        """开关只管本机；远端永远要令牌。"""
        target = self._put_library("Alice")
        with mock.patch.dict(os.environ, {"ALLOW_LOCAL_DELETE": "1"}):
            resp = self.client.delete("/api/library/Alice", headers=self.REMOTE)
        self.assertEqual(resp.status_code, 403)
        self.assertTrue(target.exists())

    def test_other_values_of_the_switch_do_not_enable_deletion(self):
        """只认 "1"：ALLOW_LOCAL_DELETE=true / yes 这类写法不放行，避免误以为是开关。"""
        target = self._put_library("Alice")
        for value in ("true", "yes", "on", "TRUE"):
            with self.subTest(value=value):
                with mock.patch.dict(os.environ, {"ALLOW_LOCAL_DELETE": value}):
                    resp = self.client.delete("/api/library/Alice")
                self.assertEqual(resp.status_code, 403)
                self.assertTrue(target.exists())

    def test_delete_token_is_not_sent_to_the_browser(self):
        """令牌只回一次，不塞进 data 里随每次请求下发。"""
        resp = self._post_analyze("MyDoc.txt")
        body = resp.get_json()
        self.assertNotIn("_deleteToken", body["data"])
        self.assertNotIn("_functionWordVectors", body["data"])


class UploadCleaningTestCase(LibraryApiTestCase):
    """
    上传的文本必须走与内置书相同的清洗管线。

    以前上传路径直接拿原始文本切块、也把原始文本写进 metadata，而界面上
    声明「文本经 Gutenberg 页眉页脚清理与缩写还原后」——两处口径必须一致，
    否则上传书的词数被页眉噪声撑大、缩写也没还原。
    """

    RAW = (
        "Header noise.\n"
        "*** START OF THE PROJECT GUTENBERG EBOOK NOVEL ***\n"
        "He said he don't know about the river. "
        + "river " * 40
        + "\n*** END OF THE PROJECT GUTENBERG EBOOK NOVEL ***\n"
        "License noise."
    )

    def _post_capturing(self):
        """记录 get_blocks 的入参和 build_book_data 的 text 入参。"""
        seen = {}

        def fake_blocks(text, **kwargs):
            seen["blocks_input"] = text
            return ["alpha", "beta"]

        def fake_build(blocks, **kwargs):
            seen["build_text"] = kwargs.get("text")
            return FAKE_BOOK

        with stub_block_count(2), \
             mock.patch("src.data_loader.get_blocks", side_effect=fake_blocks), \
             mock.patch("src.pipeline.build_book_data", side_effect=fake_build):
            data = {"file": (io.BytesIO(self.RAW.encode("utf-8")), "novel.txt")}
            resp = self.client.post("/api/analyze", data=data, content_type="multipart/form-data")
        return resp, seen

    def test_upload_text_is_cleaned_before_analysis(self):
        resp, seen = self._post_capturing()
        self.assertEqual(resp.status_code, 200)
        for field, text in (("blocks_input", seen["blocks_input"]), ("build_text", seen["build_text"])):
            with self.subTest(field=field):
                self.assertNotIn("START OF THE PROJECT GUTENBERG", text)
                self.assertNotIn("License noise", text)
                self.assertIn("do not know", text)  # 缩写已还原

    def test_upload_with_only_boilerplate_is_rejected(self):
        """整份文件只有页眉页脚时，清洗后没有正文，要给中文提示而不是硬算。"""
        raw = (
            "*** START OF THE PROJECT GUTENBERG EBOOK NOVEL ***\n"
            "*** END OF THE PROJECT GUTENBERG EBOOK NOVEL ***"
        )
        with mock.patch("src.data_loader.get_blocks", return_value=["alpha", "beta"]), \
             mock.patch("src.pipeline.build_book_data", return_value=FAKE_BOOK):
            data = {"file": (io.BytesIO(raw.encode("utf-8")), "novel.txt")}
            resp = self.client.post("/api/analyze", data=data, content_type="multipart/form-data")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("清洗后没有剩余正文", resp.get_json()["message"])


class ErrorMessageTestCase(LibraryApiTestCase):
    """错误提示必须是给非技术用户看的中文，不能把异常原文抛出去。"""

    def test_missing_file_field(self):
        resp = self.client.post("/api/analyze", data={}, content_type="multipart/form-data")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("请求中未包含文件", resp.get_json()["message"])

    def test_non_txt_rejected_with_a_way_out(self):
        """
        只收 .txt 是对的（Word 文档、PDF 是二进制），但提示必须给出「怎么办」。
        非技术用户手上多半就是一份 Word 文档，只说「只支持 .txt」等于把人堵死。
        """
        resp = self._post_analyze("novel.pdf")
        self.assertEqual(resp.status_code, 400)
        message = resp.get_json()["message"]
        self.assertIn("只支持纯文本文件（.txt）", message)
        self.assertIn("另存为", message)

    def test_gbk_chinese_is_read_then_rejected_for_the_real_reason(self):
        """
        GBK 编码的中文以前会撞在「文件不是有效的 UTF-8 编码」上：用户照着提示把文件
        转成 UTF-8，重传一次，才拿到真正的原因（本工具只分析英文）。两趟才走到终点。
        现在直接读出内容，一次就把话说对。
        """
        chinese = "白牙是一本关于狼的小说。" * 40
        resp = self._post_analyze("novel.txt", content=chinese.encode("gbk"))
        self.assertEqual(resp.status_code, 400)
        message = resp.get_json()["message"]
        self.assertIn("不是英文", message)
        self.assertNotIn("UTF-8", message)
        self.assertNotIn("编码", message)

    def test_english_saved_by_windows_is_accepted(self):
        """
        第三十批最要紧的一条：一份完全正常的英文小说，只要正文里有 Word 生成的弯引号，
        用记事本「另存为 ANSI」存一次就不是合法 UTF-8 了——以前会卡在编码上。
        该不该分析由语言闸门说了算，不由编码说了算。
        """
        english = 'He said “hello.” Then he left, and he didn’t look back at all. ' * 40
        for label, content in (
            ("cp1252（西文 Windows 记事本「另存为 ANSI」）", english.encode("cp1252")),
            ("gb18030（中文 Windows 的 Word「另存为纯文本」）", english.encode("gbk")),
        ):
            with self.subTest(label=label):
                resp = self._post_analyze("novel.txt", content=content)
                self.assertEqual(resp.status_code, 200)

    def test_empty_file_rejected(self):
        resp = self._post_analyze("novel.txt", content=b"   \n  ")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("内容为空", resp.get_json()["message"])

    def test_too_short_text_rejected(self):
        # 片段数算出来是 0 → 文本太短（这一步现在不切块，纯算术，见 count_blocks）
        with stub_block_count(0):
            data = {"file": (io.BytesIO(b"short"), "novel.txt")}
            resp = self.client.post("/api/analyze", data=data, content_type="multipart/form-data")
        self.assertEqual(resp.status_code, 400)
        message = resp.get_json()["message"]
        self.assertIn("文本太短", message)
        # 单位说清楚是「英文单词」，并给出这份文本的实际词数，用户才知道差多少
        self.assertIn("英文单词", message)
        self.assertIn("这份文本约 1 个", message)

    def test_too_long_text_names_the_numbers_and_the_way_out(self):
        """超过上限必须说清「这份多少、上限多少、怎么办」，不然用户只会以为服务器坏了。"""
        with stub_block_count(MAX_BLOCKS + 1):
            data = {"file": (io.BytesIO(b"content"), "novel.txt")}
            resp = self.client.post("/api/analyze", data=data, content_type="multipart/form-data")
        self.assertEqual(resp.status_code, 400)
        message = resp.get_json()["message"]
        self.assertIn("文本太长", message)
        self.assertIn(str(MAX_BLOCKS + 1), message)
        self.assertIn("拆分文件", message)

    def test_non_english_text_is_told_why_not_too_short(self):
        """
        中文没有空格，整本书会被当成 1 个「单词」→ 切不出块。
        语言闸门必须排在长度闸门之前，否则用户永远只看到「文本太短」
        （这里故意把片段数打成 0：消息仍是语言原因，才算顺序对了）。
        """
        chinese = "白牙是一本关于狼的小说。" * 40
        with stub_block_count(0):
            data = {"file": (io.BytesIO(chinese.encode("utf-8")), "novel.txt")}
            resp = self.client.post("/api/analyze", data=data, content_type="multipart/form-data")
        self.assertEqual(resp.status_code, 400)
        message = resp.get_json()["message"]
        self.assertIn("不是英文", message)
        self.assertNotIn("文本太短", message)

    def test_french_text_rejected_as_non_english(self):
        """有空格的非英文（法文）以前会被静默算出一堆无意义的数值。"""
        french = (
            "Le chien etait dans la neige et il ne voulait pas partir. "
            "Elle regardait les arbres de la foret avec une grande tristesse. "
        ) * 40
        with mock.patch("src.data_loader.get_blocks", return_value=["alpha"]), \
             mock.patch("src.pipeline.build_book_data", return_value=FAKE_BOOK):
            data = {"file": (io.BytesIO(french.encode("utf-8")), "novel.txt")}
            resp = self.client.post("/api/analyze", data=data, content_type="multipart/form-data")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("不是英文", resp.get_json()["message"])

    def test_analysis_failure_returns_chinese_message(self):
        """分析内部报错时给固定中文文案，不把异常字符串回显给用户。"""
        with stub_block_count(2), \
             mock.patch("src.data_loader.get_blocks", return_value=["alpha", "beta"]), \
             mock.patch("src.pipeline.build_book_data", side_effect=RuntimeError("boom in tokenizer")):
            data = {"file": (io.BytesIO(b"content"), "novel.txt")}
            resp = self.client.post("/api/analyze", data=data, content_type="multipart/form-data")

        self.assertEqual(resp.status_code, 422)
        message = resp.get_json()["message"]
        self.assertIn("文本分析失败", message)
        self.assertNotIn("boom in tokenizer", message)


class UploadProjectionTestCase(unittest.TestCase):
    """上传的书必须投影到与内置书相同的基底上，否则跨书比较不成立。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.raw = root / "data" / "raw"
        self.processed = root / "data" / "processed"
        self.library = root / "data" / "library"
        self.raw.mkdir(parents=True)
        self.processed.mkdir(parents=True)
        self.library.mkdir(parents=True)

        self._patches = [
            mock.patch.object(api_server, "BASE_DIR", root),
            mock.patch.object(api_server, "DATA_DIR", self.raw),
            mock.patch.object(api_server, "LIBRARY_DIR", self.library),
            mock.patch.object(api_server, "_ensure_demo_data", lambda: True),
        ]
        for p in self._patches:
            p.start()
        self.addCleanup(self._cleanup)

        # 投影模型是进程级懒加载的，每个用例都要先把它清空
        api_server._projection_model.update(loaded=False, model=None)
        api_server._rate_state.clear()
        api_server.app.config["TESTING"] = True
        self.client = api_server.app.test_client()

    def _cleanup(self):
        for p in self._patches:
            p.stop()
        api_server._projection_model.update(loaded=False, model=None)
        self._tmp.cleanup()

    def _write_model(self, path):
        from src.metrics import function_word_matrix
        from src.projection import build_model, save_model

        blocks = ["the of and a to he", "he she it the and of", "the and of a to the"]
        matrix, vocabulary = function_word_matrix(blocks, vocabulary=["the", "of", "and", "a", "to", "he", "she", "it"])
        model = build_model(matrix, vocabulary, fitted_on={"books": ["test"]})
        save_model(model, path)
        return model

    def _post(self, recorder):
        with stub_block_count(2), \
             mock.patch("src.data_loader.get_blocks", return_value=["alpha", "beta"]), \
             mock.patch("src.pipeline.build_book_data", side_effect=recorder):
            data = {"file": (io.BytesIO(b"content"), "novel.txt")}
            return self.client.post("/api/analyze", data=data, content_type="multipart/form-data")

    def test_upload_projects_with_shared_model(self):
        model_path = Path(self._tmp.name) / "pca_model.json"
        model = self._write_model(model_path)

        captured = {}

        def recorder(blocks, **kwargs):
            captured.update(kwargs)
            return FAKE_BOOK

        with mock.patch("src.projection.MODEL_PATH", model_path):
            resp = self._post(recorder)

        self.assertEqual(resp.status_code, 200)
        self.assertIsNotNone(captured.get("projection"), "上传时没有用共享投影模型")
        self.assertEqual(captured["projection"]["modelId"], model["modelId"])

    def test_upload_falls_back_to_per_book_without_model(self):
        """模型文件缺失时不能瞎猜坐标，交给 build_book_data 自己拟合并标注 perBook。"""
        captured = {}

        def recorder(blocks, **kwargs):
            captured.update(kwargs)
            return FAKE_BOOK

        with mock.patch("src.projection.MODEL_PATH", Path(self._tmp.name) / "not-there.json"):
            resp = self._post(recorder)

        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(captured.get("projection"))

    def test_upload_passes_real_text_for_word_count(self):
        """上传时要把全文交给管线，否则算不出真实总词数和章节。"""
        captured = {}

        def recorder(blocks, **kwargs):
            captured.update(kwargs)
            return FAKE_BOOK

        resp = self._post(recorder)

        self.assertEqual(resp.status_code, 200)
        self.assertIn("text", captured)
        self.assertTrue(captured["text"])
        self.assertEqual(captured["block_size"], api_server.BLOCK_SIZE)
        self.assertEqual(captured["overlap"], api_server.OVERLAP)


class FingerprintConditionalTestCase(LibraryApiTestCase):
    """
    /api/fingerprint-data 首屏必拉（未压缩 1.5 MB），重复访问应当走 304。
    ETag 取自语料指纹，所以「数据变了」必须让 ETag 跟着变——否则用户会拿到旧缓存。
    """

    def _get(self, etag=None):
        headers = {"If-None-Match": etag} if etag else {}
        return self.client.get("/api/fingerprint-data", headers=headers)

    def test_first_response_carries_etag_and_no_cache(self):
        resp = self._get()
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.headers.get("ETag"))
        self.assertEqual(resp.headers.get("Cache-Control"), "no-cache")

    def test_same_corpus_returns_304_with_empty_body(self):
        etag = self._get().headers["ETag"]
        again = self._get(etag)
        self.assertEqual(again.status_code, 304)
        self.assertEqual(again.get_data(), b"")

    def test_regenerated_corpus_invalidates_etag(self):
        etag = self._get().headers["ETag"]
        # 换一份语料：文件大小和 mtime 都变了
        (self.processed / "all_books.json").write_text(
            json.dumps({BUILTIN_NAME: FAKE_BOOK, "Second": FAKE_BOOK}, ensure_ascii=False),
            encoding="utf-8")
        fresh = self._get(etag)
        self.assertEqual(fresh.status_code, 200, "语料变了就不该再给 304")
        self.assertNotEqual(fresh.headers["ETag"], etag)

    def test_library_change_invalidates_etag(self):
        """「我的图书馆」也是语料的一部分：新增一本书同样要让 ETag 变。"""
        etag = self._get().headers["ETag"]
        self._put_library("Alice")
        fresh = self._get(etag)
        self.assertEqual(fresh.status_code, 200)
        self.assertIn("Alice", fresh.get_json()["data"])

    def test_missing_corpus_has_no_etag(self):
        (self.processed / "all_books.json").unlink()
        resp = self._get()
        self.assertEqual(resp.status_code, 404)
        self.assertIsNone(resp.headers.get("ETag"))


class DemoCorpusStalenessTestCase(unittest.TestCase):
    """
    _demo_corpus_is_current：判断 all_books.json 是不是当前管线生成的。

    纯函数，只读文件内容，不碰任何全局状态。
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.target = Path(self._tmp.name) / "all_books.json"

    def _write(self, payload):
        self.target.write_text(payload, encoding="utf-8")

    def _corpus(self, **meta):
        self._write(json.dumps({BUILTIN_NAME: {"metadata": meta}}, ensure_ascii=False))

    def test_current_version_is_current(self):
        self._corpus(schemaVersion=api_server._DEMO_SCHEMA_VERSION)
        self.assertTrue(api_server._demo_corpus_is_current(self.target))

    def test_newer_version_still_counts_as_current(self):
        """将来管线再升级（3、4…）时，这个判定不该反过来把新数据当成旧的。"""
        self._corpus(schemaVersion=api_server._DEMO_SCHEMA_VERSION + 1)
        self.assertTrue(api_server._demo_corpus_is_current(self.target))

    def test_missing_schema_version_is_stale(self):
        """线上那份一个月的旧数据就是这个形状：只有 4 个统计量，没有 schemaVersion。"""
        self._corpus(totalBlocks=22, totalWords=220000, avgSentenceLength=18.97)
        self.assertFalse(api_server._demo_corpus_is_current(self.target))

    def test_older_version_is_stale(self):
        self._corpus(schemaVersion=api_server._DEMO_SCHEMA_VERSION - 1)
        self.assertFalse(api_server._demo_corpus_is_current(self.target))

    def test_corrupt_json_is_stale(self):
        self._write("not-json{{{")
        self.assertFalse(api_server._demo_corpus_is_current(self.target))

    def test_missing_file_is_stale(self):
        self.assertFalse(api_server._demo_corpus_is_current(self.target))

    def test_unexpected_shapes_are_stale(self):
        """文件可能被别的东西覆盖成任意形状，读不动一律当过期，别抛异常。"""
        for payload in ("[]", '"a string"', "null", '{"White Fang": null}', '{"White Fang": "x"}'):
            with self.subTest(payload=payload):
                self._write(payload)
                self.assertFalse(api_server._demo_corpus_is_current(self.target))


class DemoDataSelfHealTestCase(unittest.TestCase):
    """
    _ensure_demo_data：判断「示例数据要不要重算」。

    旧实现只看文件在不在，而 data/processed/ 不进版本库——旧克隆里那份旧管线产物会
    一直存在、也就永远不会被重算，线上因此喂了一个月的旧数据。这里钉住两件事：
    结构过旧要重算；重算失败时**不能**让此后每个请求都卡满一次生成。
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.raw = root / "data" / "raw"
        self.processed = root / "data" / "processed"
        self.raw.mkdir(parents=True)
        self.processed.mkdir(parents=True)
        self.target = self.processed / "all_books.json"
        (self.raw / f"{BUILTIN_NAME}.txt").write_text("builtin content. " * 30, encoding="utf-8")

        # 这几个都是模块级状态、跨用例共享，进出都要摆正
        self._saved = (api_server._demo_data_ready, api_server._demo_repair_stamp)
        api_server._demo_data_ready = False
        api_server._demo_repair_stamp = None

        self._patches = [
            mock.patch.object(api_server, "BASE_DIR", root),
            mock.patch.object(api_server, "DATA_DIR", self.raw),
            mock.patch.object(api_server, "_projection_model", {"loaded": False, "model": None}),
            mock.patch.object(api_server, "_corpus_cache", {"key": None, "data": None, "message": None}),
        ]
        for p in self._patches:
            p.start()
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        for p in self._patches:
            p.stop()
        api_server._demo_data_ready, api_server._demo_repair_stamp = self._saved
        self._tmp.cleanup()

    def _write_corpus(self, schema_version):
        """写一份 all_books.json；schema_version 传 None 表示旧管线那种没有该字段的。"""
        meta = {"totalBlocks": 1, "totalWords": 2}
        if schema_version is not None:
            meta["schemaVersion"] = schema_version
        self.target.write_text(
            json.dumps({BUILTIN_NAME: {"metadata": meta, "sentenceLength": []}}, ensure_ascii=False),
            encoding="utf-8",
        )

    def _run(self, side_effect=None):
        """跑一次 _ensure_demo_data，返回 (结果, 生成函数被调用次数)。"""
        def fake_process_all_books():
            if side_effect is not None:
                side_effect()

        with mock.patch("generate_data.process_all_books", side_effect=fake_process_all_books) as gen:
            result = api_server._ensure_demo_data()
            return result, gen.call_count

    # ---- 该重算的场合 ----

    def test_missing_file_is_generated(self):
        result, calls = self._run(side_effect=lambda: self._write_corpus(api_server._DEMO_SCHEMA_VERSION))
        self.assertTrue(result)
        self.assertEqual(calls, 1)

    def test_stale_file_is_regenerated(self):
        """本批针对线上那个真实故障：文件在、但只有旧管线的字段。"""
        self._write_corpus(None)
        result, calls = self._run(side_effect=lambda: self._write_corpus(api_server._DEMO_SCHEMA_VERSION))
        self.assertTrue(result)
        self.assertEqual(calls, 1)
        self.assertTrue(api_server._demo_corpus_is_current(self.target))

    def test_corrupt_file_is_regenerated(self):
        self.target.write_text("not-json{{{", encoding="utf-8")
        result, calls = self._run(side_effect=lambda: self._write_corpus(api_server._DEMO_SCHEMA_VERSION))
        self.assertTrue(result)
        self.assertEqual(calls, 1)

    # ---- 不该重算的场合 ----

    def test_current_file_is_left_alone(self):
        self._write_corpus(api_server._DEMO_SCHEMA_VERSION)
        result, calls = self._run()
        self.assertTrue(result)
        self.assertEqual(calls, 0)

    def test_ready_flag_short_circuits(self):
        api_server._demo_data_ready = True
        self._write_corpus(None)  # 哪怕是旧的也不再看文件
        result, calls = self._run()
        self.assertTrue(result)
        self.assertEqual(calls, 0)

    def test_no_raw_sources_returns_false(self):
        for stray in self.raw.glob("*.txt"):
            stray.unlink()
        result, calls = self._run()
        self.assertFalse(result)
        self.assertEqual(calls, 0)

    # ---- 失败不能变成每请求一次重算 ----

    def test_failed_generation_is_not_retried(self):
        """重算要跑 1~3 分钟。同一份旧文件只试一次，否则线上每个请求都要卡满。"""
        self._write_corpus(None)
        result1, calls1 = self._run()  # 生成函数没写文件 = 失败
        self.assertFalse(result1)
        self.assertEqual(calls1, 1)

        result2, calls2 = self._run()
        self.assertFalse(result2)
        self.assertEqual(calls2, 0, "同一份旧文件不该被反复重算")

    def test_retry_allowed_after_file_changes(self):
        """文件被换过（比如管理员手动拷了一份进来）就该重新判一次。"""
        self._write_corpus(None)
        self._run()
        self._write_corpus(1)  # 仍然是旧的，但是另一份
        result, calls = self._run(side_effect=lambda: self._write_corpus(api_server._DEMO_SCHEMA_VERSION))
        self.assertTrue(result)
        self.assertEqual(calls, 1)

    def test_generation_exception_is_swallowed(self):
        """生成函数抛异常（例如 raw/ 里的书读坏了）不能把请求变成 500。"""
        self._write_corpus(None)

        def boom():
            raise RuntimeError("nltk 挂了")

        with mock.patch("generate_data.process_all_books", side_effect=boom):
            self.assertFalse(api_server._ensure_demo_data())


class ExcerptEndpointTestCase(LibraryApiTestCase):
    """第二十一批：长摘录不随页面下发，改由 /api/excerpt 按段取。

    三条「写错了也不报错、只是功能静默变差」的规则各有用例钉住：
      ① 下发剥离**绝不就地改**共享语料缓存（拉过首屏之后，长摘录仍要取得到）；
      ② 找摘录必须扫完所有指标（v1 只有 functionWords 带长文，撞上别的指标的
         短摘录就返回的话，永远拿不到那份长的）；
      ③ 未落盘的上传响应仍带长摘录——那是它在世界上唯一的一份，剥了就没处取。
    """

    BOOK_NAME = "LongBook"

    def _excerpt_book(self, long_on=None, short_only=False):
        """四个指标各带一份能分辨出处的短摘录，长摘录只挂在指定/全部指标上。"""
        book = copy.deepcopy(FAKE_BOOK)
        for key in api_server._METRIC_KEYS:
            entry = book[key][0]
            entry["preview"] = f"SHORT-{key}"
            entry.pop("extended_preview", None)
            if not short_only and (long_on is None or key == long_on):
                entry["extended_preview"] = f"LONG-{key} " + "x" * 20
        return book

    # ---- 取得到、且取的是最长的那份 ----

    def test_excerpt_finds_long_text_scanned_last(self):
        """长摘录只在 sentenceLength 上（排序后最后一个扫到），
        前面几个指标只有短摘录——提前返回的实现会在这里拿到 SHORT- 开头。"""
        self._put_library(self.BOOK_NAME, self._excerpt_book(long_on="sentenceLength"))
        resp = self.client.get(f"/api/excerpt/{self.BOOK_NAME}?block=0")
        self.assertEqual(resp.status_code, 200)
        result = resp.get_json()
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["book"], self.BOOK_NAME)
        self.assertEqual(result["block"], 0)
        self.assertTrue(result["extended"])
        self.assertTrue(result["excerpt"].startswith("LONG-sentenceLength"))

    def test_v1_book_only_functionwords_has_long_text(self):
        """v1 老数据的长摘录只存在 functionWords 一处（出厂夹具就是这个形状）。"""
        book = copy.deepcopy(FAKE_BOOK)
        book["functionWords"][0]["extended_preview"] = "LONG-functionWords " + "y" * 20
        self._put_library(self.BOOK_NAME, book)
        result = self.client.get(f"/api/excerpt/{self.BOOK_NAME}?block=0").get_json()
        self.assertTrue(result["extended"])
        self.assertTrue(result["excerpt"].startswith("LONG-functionWords"))

    def test_short_only_book_returns_preview_with_extended_false(self):
        """只有短摘录的书（老数据或该段没长文）：照样 200，但 extended=False。"""
        self._put_library(self.BOOK_NAME, self._excerpt_book(short_only=True))
        resp = self.client.get(f"/api/excerpt/{self.BOOK_NAME}?block=0")
        self.assertEqual(resp.status_code, 200)
        result = resp.get_json()
        self.assertFalse(result["extended"])
        self.assertTrue(result["excerpt"].startswith("SHORT-"))

    # ---- 找不到的时候 ----

    def test_unknown_block_returns_404(self):
        self._put_library(self.BOOK_NAME, self._excerpt_book())
        resp = self.client.get(f"/api/excerpt/{self.BOOK_NAME}?block=999")
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.get_json()["status"], "error")

    def test_unknown_book_returns_404(self):
        resp = self.client.get("/api/excerpt/NoSuchBook?block=0")
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.get_json()["status"], "error")

    def test_block_without_any_text_returns_404(self):
        book = copy.deepcopy(FAKE_BOOK)
        for key in api_server._METRIC_KEYS:
            book[key][0].pop("extended_preview", None)
            book[key][0].pop("preview", None)
        self._put_library(self.BOOK_NAME, book)
        resp = self.client.get(f"/api/excerpt/{self.BOOK_NAME}?block=0")
        self.assertEqual(resp.status_code, 404)
        self.assertIn("摘录", resp.get_json()["message"])

    def test_block_param_validated(self):
        """缺参 / 空 / 非数字 / 小数 / 负数都是 400，不能落进 int() 的异常里变成 500。"""
        self._put_library(self.BOOK_NAME, self._excerpt_book())
        for query in ("", "?block=", "?block=abc", "?block=1.5", "?block=-1", "?block= "):
            with self.subTest(query=query):
                resp = self.client.get(f"/api/excerpt/{self.BOOK_NAME}{query}")
                self.assertEqual(resp.status_code, 400)
                self.assertIn("非负整数", resp.get_json()["message"])

    # ---- 书架边界与中文书名 ----

    def test_another_visitor_cannot_read_my_excerpt(self):
        self._put_library(self.BOOK_NAME, self._excerpt_book())
        other = self._another_visitor("othervisitor00000002")
        resp = other.get(f"/api/excerpt/{self.BOOK_NAME}?block=0")
        self.assertEqual(resp.status_code, 404)

    def test_cjk_book_name_round_trips(self):
        name = "实验（我的）"
        self._put_library(name, self._excerpt_book())
        resp = self.client.get("/api/excerpt/" + quote(name) + "?block=0")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.get_json()["extended"])

    # ---- 剥离只发生在响应里 ----

    def test_fingerprint_response_carries_no_long_excerpts(self):
        self._put_library(self.BOOK_NAME, self._excerpt_book())
        resp = self.client.get("/api/fingerprint-data")
        self.assertEqual(resp.status_code, 200)
        body = resp.get_data(as_text=True)
        self.assertNotIn("extended_preview", body)
        self.assertIn('"preview"', body)  # 短摘录照旧下发

    def test_single_book_endpoint_is_stripped_too(self):
        resp = self.client.get(f"/api/book/{BUILTIN_NAME}")
        self.assertEqual(resp.status_code, 200)
        body = json.dumps(resp.get_json()["data"], ensure_ascii=False)
        self.assertNotIn("extended_preview", body)

    def test_fetching_first_does_not_break_excerpt(self):
        """剥离若就地改动了 _load_corpus 的共享缓存，这条就会变成 extended=False。
        同一份缓存既服务首屏、也服务按需取，就地 pop 是这类实现最容易踩的坑。"""
        self._put_library(self.BOOK_NAME, self._excerpt_book(long_on="sentenceLength"))
        self.client.get("/api/fingerprint-data")
        self.client.get(f"/api/book/{self.BOOK_NAME}")
        result = self.client.get(f"/api/excerpt/{self.BOOK_NAME}?block=0").get_json()
        self.assertTrue(result["extended"])
        self.assertTrue(result["excerpt"].startswith("LONG-sentenceLength"))

    def test_saved_upload_strips_response_but_keeps_file(self):
        resp = self._post_analyze("MyDoc.txt")
        result = resp.get_json()
        self.assertEqual(result["status"], "success")
        body = json.dumps(result["data"], ensure_ascii=False)
        self.assertNotIn("extended_preview", body)
        # 落盘那份一个字节都不少：长摘录只是不下发，不是不存
        on_disk = json.loads((self.shelf / "MyDoc.json").read_text(encoding="utf-8"))
        self.assertEqual(on_disk["functionWords"][0]["extended_preview"], "hello")

    def test_unsaved_upload_response_keeps_long_excerpt(self):
        """没落盘的上传，响应里的长摘录是唯一的一份副本，剥了用户就只能复制 150 字。"""
        resp = self._post_analyze("MyDoc.txt", save=False)
        data = resp.get_json()["data"]
        self.assertEqual(data["functionWords"][0]["extended_preview"], "hello")
        # 同时确认没有把模块级夹具就地改坏（后面还有用例要用它）
        self.assertEqual(FAKE_BOOK["functionWords"][0]["extended_preview"], "hello")

    # ---- 站点图标 ----

    def test_favicon_is_served(self):
        resp = self.client.get("/favicon.ico")
        self.addCleanup(resp.close)  # 文件响应持着句柄，不关会有 ResourceWarning
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.mimetype, "image/svg+xml")
        self.assertIn(b"<svg", resp.get_data())


if __name__ == "__main__":
    unittest.main(verbosity=2)
