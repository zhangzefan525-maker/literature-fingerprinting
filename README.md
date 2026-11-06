# 文学指纹 · Literature Fingerprinting

> 不用写代码，也能一眼看懂「不同作家的写作风格差在哪里」。

[![tests](https://github.com/zhangzefan525-maker/literature-fingerprinting/actions/workflows/tests.yml/badge.svg)](https://github.com/zhangzefan525-maker/literature-fingerprinting/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 📖 这是什么

「文学指纹」是 Keim & Oelke (2007) 提出的一种方法：把一部小说切成一段一段，计算每一段的平均句长、词汇丰富度等特征，再把这些特征画成像素块和交互图表。每个作家写作的习惯不同，画出来的「指纹」也就不一样，于是风格的差异能直接看出来。

这个仓库把它做成了一个网页工具：Python 负责计算，D3.js 负责图表，全程点击操作。

### 能做什么

- **分析自己的书**：上传任意一部英文小说（`.txt`），几秒钟生成它的文学指纹。
- **和名著对比**：与内置的 4 本示例书（马克·吐温、杰克·伦敦各两本）并列比较。
- **层层下钻**：拖拽、点击、悬停，一路看到具体段落，看这本书的高潮在哪、哪段最特别。
- **留存分析**：勾选「存入我的图书馆」，派生结果会保存下来，刷新后仍在，也可随时删除。
- **出处定位**：每个数据点都标着「第 X/N 块 · 约全书 Y% · 本块词数」，原文片段可一键复制。
- **带范围的解读**：指标提示给出按当前已加载书籍算出的参考区间，避免把裸数字当绝对标准。

适合文学研究者、语言学习者和读书爱好者——**全程不需要写任何代码**。

## 🌐 在线体验

已部署的演示站，浏览器直接打开：

<http://39.96.194.197/visualization>

> 在线版会把上传的文本发到服务器处理；只有勾选「存入我的图书馆」才写入服务器磁盘（重新部署可能被清空）。介意隐私请用本地版。

## 🚀 本地运行

需要 Python 3.11 以上（`requirements.txt` 钉住的 scikit-learn 与 scipy 在 3.10 上装不上）。

```bash
git clone git@github.com:zhangzefan525-maker/literature-fingerprinting.git
cd literature-fingerprinting

pip install -r requirements.txt
python -m nltk.downloader punkt punkt_tab stopwords   # 不是 pip 包，需要单独下载

python generate_data.py    # 生成 4 本示例书的数据，约 1–2 分钟
python api_server.py       # 打开 http://127.0.0.1:5000/visualization
```

Windows 上也可以直接双击 `start.bat`，它会跳过已经生成过的示例数据，并在启动后自动打开浏览器。

**跑测试**：

```bash
python -m unittest discover -s tests -q   # 400 余条
node --check static/js/d3-charts.js       # 改过前端时
```

## 👀 怎么看这些图

1. **选书**：顶部点书名，可以一次点多本，图表会自动变成并排对比。
2. **看局部**：在右下角「趋势演变」图上拖拽，选出一段（比如某个章节），左边所有图立刻只显示这一段。
3. **看细节**：点任意柱子或线条，右侧会列出这一段里数值最高的 3 个段落，附原文片段和关键词。
4. **排序与高亮**：点图表标题旁的排序图标可切换排序；悬停任一元素，相关的书会被高亮。

## 📊 三个指标

| 指标 | 公式 | 怎么读 |
| --- | --- | --- |
| 平均句长 | 词数 ÷ 句数 | 越大句子越长、越书面 |
| 辛普森指数 D | `D = Σ n(n−1) / [N(N−1)]` | 词汇重复度，越接近 1 重复得越厉害 |
| Honoré 词汇丰富度 R | `R = 100 × ln N / (1 − V1/V)` | 越大词汇越丰富；`V1` 是只出现一次的词型数 |

符号含义：`N` 为词元总数，`V` 为不同词型数，`n` 为某个词的词频。

这三个都是计量文体学里既有的方法，不是自拟的公式。之所以不用最常见的 TTR（类符/形符比），是因为 TTR 随文本长度单调下降——同一个作家，5 万词的段落和 80 万词的全书会给出两个不同的答案，跨书比较就失去意义。辛普森 D 与 Honoré R 对长度远没有那么敏感，正是为了跨书比较才选的它们。

## 🔬 跨书可比是怎么保证的

这是整个项目里最容易做错的一环。

1. **先归一化再降维。** 功能词矩阵按行做 L1 归一化，第一主成分刻画的是「这些小词怎么用」，而不是「这一段有多长」。
2. **只拟合一次。** 生成数据时把内置书的窗口合起来拟合一次 2 维 PCA，模型落盘；之后无论内置书还是上传的书，都只用这一个模型投影，不再重新拟合。同一段文字在任何时候、任何机器上都落在同一个位置。
3. **把会漂移的坑堵上。** 主成分符号按「绝对值最大的载荷为正」确定化，求解器钉死为 `full`，避免换版本或换一批书之后轴的方向翻转。
4. **模型带指纹。** 每个模型算一个短 sha1，写进导出文件和页面元数据，「这批坐标出自哪个模型」是印在图上的。
5. **轴上有白话说明。** 取载荷最大的几个功能词，分正负两段写成「横轴越靠右，the / of 这类小词占比越高」。

## ⚠️ 已知的局限

- **语料只有 4 本书、2 位作者**，同属 19 世纪末—20 世纪初的英语白话小说。任何结论都不能外推到别的时代、体裁或语言。
- **只支持英文**。分词、停用词表、标点清洗都按英文设计。
- **句长对体裁敏感**：书信体、剧本、意识流会天然拉低或拉高这个数。
- **功能词表用 NLTK 英语停用词近似**（198 词），是一个常用而粗糙的代理。
- **相邻窗口重叠 90%**：图上的点不是独立样本，用来做显著性检验会高估证据量。描述性结论不受影响。
- **窗口从 1 万词起步**：太短的文本无法生成指纹，这对短篇和诗歌是硬门槛。

## 🛠️ 项目结构

```text
├── api_server.py          Flask API 服务器，页面与接口都从这里出
├── generate_data.py       批处理：原始文本 → 指纹数据
├── d3_visualization.html  主页面
├── src/
│   ├── data_loader.py     文本清洗与滑动窗口切分
│   ├── metrics.py         三个文体指标
│   ├── projection.py      共享功能词投影模型
│   ├── pipeline.py        生成与上传共用的处理管线
│   ├── authorship.py      作者归属验证
│   ├── analysis_utils.py  章节识别、异常片段
│   └── atomic_io.py       原子写入
├── static/
│   ├── css/d3-style.css
│   └── js/d3-charts.js    D3 绘图与交互
├── tests/                 单元测试与 API 契约测试
├── data/
│   ├── raw/               原始小说文本
│   ├── processed/         生成的数据（不入库）
│   └── library/           用户保存的书架（不入库）
├── requirements.txt
├── Dockerfile
└── start.bat
```

`data/processed/` 与 `data/library/` 都在 `.gitignore` 里：前者能重新生成，后者属于使用者自己的数据。删除「我的图书馆」里的书需要保存时签发的令牌；清过浏览器数据又想删本机旧文件时，可以 `ALLOW_LOCAL_DELETE=1 python api_server.py` 启动一次，或直接删掉 `data/library/<书名>.json`。

## 🚢 部署

- **Docker**：`docker build -t literature-fingerprinting . && docker run -p 8000:8000 literature-fingerprinting`
- **Render**：仓库根目录的 `render.yaml` 可以直接作为 Blueprint 使用。
- **自己的服务器**：`gunicorn api_server:app --bind 127.0.0.1:8000 --timeout 180`，前面挂 nginx。

## 📚 参考资料

1. Keim, D. A., & Oelke, D. (2007). *Literature Fingerprinting: A New Method for Visual Literary Analysis*.
2. D3.js Gallery & Documentation.
3. Project Gutenberg（文本来源）。

## 许可证与更新

以 [MIT](LICENSE) 发布。参与方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

每一次改动的详细记录在 [docs/CHANGELOG.md](docs/CHANGELOG.md)。
