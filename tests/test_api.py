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

BUILTIN_NAME = "White Fang"

# 结构与真实单书一致的最小桩（足够让路由/合并逻辑消费）
FAKE_BOOK = {
    "sentenceLength": [{"block": 0, "value": 1.0, "keywords": ["alpha"], "preview": "hello", "wordCount": 2}],
    "simpsonIndex": [{"block": 0, "value": 0.5, "keywords": ["alpha"], "preview": "hello", "wordCount": 2}],
    "hapaxLegomena": [{"block": 0, "value": 100.0, "keywords": ["alpha"], "preview": "hello", "wordCount": 2}],
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
        # 限流是进程级的：不清理的话，用例一多就会互相拖累（后跑的用例收到 429）
        api_server._rate_state.clear()

    def _cleanup(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def _put_library(self, name, payload=None):
        target = self.library / f"{name}.json"
        target.write_text(json.dumps(payload if payload is not None else FAKE_BOOK, ensure_ascii=False),
                          encoding="utf-8")
        return target

    def _post_analyze(self, filename, content=b"content", save=True):
        """带桩地走 /api/analyze：不做真实 NLTK 分析。"""
        with mock.patch("src.data_loader.get_blocks", return_value=["alpha", "beta"]), \
             mock.patch("src.pipeline.build_book_data", return_value=FAKE_BOOK):
            data = {"file": (io.BytesIO(content), filename)}
            if save:
                data["save"] = "1"
            return self.client.post("/api/analyze", data=data, content_type="multipart/form-data")

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
        self.assertTrue((self.library / f"{BUILTIN_NAME}（我的）.json").exists())
        # 内置原始文件未被覆盖
        self.assertTrue((self.raw / f"{BUILTIN_NAME}.txt").exists())

    def test_analyze_without_save_does_not_persist(self):
        resp = self._post_analyze("MyDoc.txt", save=False)
        result = resp.get_json()
        self.assertEqual(result["status"], "success")
        self.assertFalse(result["saved"])
        self.assertNotIn("storage", result)
        self.assertEqual(list(self.library.glob("*.json")), [])

    def test_analyze_same_name_twice_replaces_single_file(self):
        self._post_analyze("MyDoc.txt")
        self._post_analyze("MyDoc.txt")
        files = list(self.library.glob("*.json"))
        self.assertEqual([f.name for f in files], ["MyDoc.json"])

    # ---- /api/fingerprint-data 合并 ----
    def test_fingerprint_merges_library_only_when_absent(self):
        self._put_library("Alice")
        # 与内置同名的书库文件不应覆盖内置数据
        self._put_library(BUILTIN_NAME, {"metadata": {}, "sentenceLength": []})
        # 损坏文件应被跳过，不影响其余合并
        (self.library / "Bad.json").write_text("not-json{{{", encoding="utf-8")

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
        self.assertFalse((self.library / "Alice.json").exists())
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
        self.assertFalse((self.library / "实验（我的）.json").exists())


class LegacyLibraryTestCase(LibraryApiTestCase):
    """老版本（v1）书库文件：只做内存兼容，绝不改写磁盘上的旧文件。"""

    # v1 的 totalWords 其实是重叠窗口的词次累加（虚高近十倍），不能当成真实词数
    V1_BOOK = {
        "sentenceLength": [{"block": 0, "value": 2.5, "keywords": ["alpha"], "preview": "hello", "wordCount": 2}],
        "simpsonIndex": [{"block": 0, "value": 0.5, "keywords": ["alpha"], "preview": "hello", "wordCount": 2}],
        "hapaxLegomena": [{"block": 0, "value": 100.0, "keywords": ["alpha"], "preview": "hello", "wordCount": 2}],
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

    REMOTE = {"Host": "literature-fingerprinting.onrender.com"}

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
        stored = json.loads((self.library / "MyDoc.json").read_text(encoding="utf-8"))
        self.assertEqual(stored["_deleteToken"], token)

        resp = self.client.delete("/api/library/MyDoc",
                                  headers=dict(self.REMOTE, **{"X-Delete-Token": token}))
        self.assertEqual(resp.status_code, 200)
        self.assertFalse((self.library / "MyDoc.json").exists())

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
        self.assertFalse((self.library / "Alice.json").exists())

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

        with mock.patch("src.data_loader.get_blocks", side_effect=fake_blocks), \
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

    def test_non_txt_rejected(self):
        resp = self._post_analyze("novel.pdf")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("仅支持 .txt", resp.get_json()["message"])

    def test_non_utf8_rejected(self):
        resp = self._post_analyze("novel.txt", content="中文 GBK 文本".encode("gbk"))
        self.assertEqual(resp.status_code, 400)
        self.assertIn("UTF-8", resp.get_json()["message"])

    def test_empty_file_rejected(self):
        resp = self._post_analyze("novel.txt", content=b"   \n  ")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("内容为空", resp.get_json()["message"])

    def test_too_short_text_rejected(self):
        # get_blocks 返回空 → 文本太短
        with mock.patch("src.data_loader.get_blocks", return_value=[]):
            data = {"file": (io.BytesIO(b"short"), "novel.txt")}
            resp = self.client.post("/api/analyze", data=data, content_type="multipart/form-data")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("文本太短", resp.get_json()["message"])

    def test_analysis_failure_returns_chinese_message(self):
        """分析内部报错时给固定中文文案，不把异常字符串回显给用户。"""
        with mock.patch("src.data_loader.get_blocks", return_value=["alpha", "beta"]), \
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
        with mock.patch("src.data_loader.get_blocks", return_value=["alpha", "beta"]), \
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
