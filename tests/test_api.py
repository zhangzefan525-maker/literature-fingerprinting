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
        self._put_library("Alice")
        resp = self.client.delete("/api/library/Alice")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse((self.library / "Alice.json").exists())
        # 二次删除 → 404
        resp2 = self.client.delete("/api/library/Alice")
        self.assertEqual(resp2.status_code, 404)

    def test_delete_builtin_is_rejected(self):
        resp = self.client.delete(f"/api/library/{BUILTIN_NAME}")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("内置示例书不能删除", resp.get_json()["message"])

    def test_delete_cjk_library_book(self):
        self._put_library("实验（我的）")
        path = "/api/library/" + quote("实验（我的）")
        resp = self.client.delete(path)
        self.assertEqual(resp.status_code, 200)
        self.assertFalse((self.library / "实验（我的）.json").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
