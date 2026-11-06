# 参与这个项目

仓库有两种读者：想用它的人读 [README](README.md)，想改它的人读这一页。

动手之前先说一句：**涉及指标口径的改动，请先开 Issue 讨论，不要直接写 PR。**
这个工具的价值在于数字能被解释，一个没人说得清来路的数字比没有更糟。

## 本地跑起来

需要 Python 3.11 以上——`requirements.txt` 钉住的 scikit-learn 1.8 与 scipy 1.16
在 3.10 上装不上。

```bash
python -m venv .venv
source .venv/bin/activate        # Windows 用 .venv\Scripts\activate
pip install -r requirements.txt
python -c "import nltk; nltk.download('punkt'); nltk.download('punkt_tab'); nltk.download('stopwords')"
python generate_data.py          # 生成 4 本示例书的指纹数据，约 1–2 分钟
python api_server.py             # 打开 http://127.0.0.1:5000/visualization
```

Windows 上也可以直接双击 `start.bat`，它会跳过已生成的示例数据。

## 跑测试

```bash
python -m unittest discover -s tests -q
```

前端没有构建步骤。改了 `static/js/d3-charts.js`，至少先做一次语法检查：

```bash
node --check static/js/d3-charts.js
```

**只跑单测不够。** 这个项目出过的 bug，多数不是算错，而是「数字对、话说错了」或者
「桌面对、手机上挤没了」。改了前端，请在真实浏览器里点一遍，并在 390px 左右宽度下再看一眼。

## 提 PR 前请确认

- 写清改了什么、为什么改、怎么验证的。PR 模板里有现成的清单。
- **三个指标与投影坐标**（句长、Simpson、Hapax，以及星系的 PCA 坐标）是方法口径，
  改了它，这个工具算的就是另一件事。确需改动，请在 PR 里附上方法依据和重算说明。
- 中文文案的判据是「读者看完能不能执行下一步」，不是「写得全不全」。先删重复、
  把结论提到最前面，通常比再补一段解释更有用。
- 不提交 `data/processed/`、`data/library/`、`*.log`、课程报告 PDF，以及任何个人信息。
  这些都在 `.gitignore` 里；如果 `git status` 又冒出它们，先查是不是用了 `git add -f`。

## 提交信息

中文，一句话说清这一批改了什么：

```
第六十三批：图下长说明分两层，把首屏还给图
```

改动较大时在正文里列条目，并写清验证方式（跑了哪些测试、在哪些视口看过）。

## 报告问题

- 页面不对、操作没反应、数字对不上：用「报告一个问题」模板开 Issue，
  附上浏览器、屏幕宽度和复现步骤。
- 安全问题：**不要开公开 Issue**，按 [SECURITY.md](SECURITY.md) 的渠道报告。
- 行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 许可证

本项目以 [MIT](LICENSE) 发布。提交 PR 即表示你同意自己的贡献以同一许可证发布。
