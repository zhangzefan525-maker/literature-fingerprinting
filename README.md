# 文学指纹 · Literature Fingerprinting

> 不用写代码，也能一眼看懂「不同作家的写作风格差在哪里」。

## 📖 产品介绍

### 这是什么？

「文学指纹」（Literature Fingerprinting）是 Keim & Oelke (2007) 提出的一种方法：把一部小说切成一段一段，计算每一段的平均句长、词汇丰富度等特征，再把这些特征画成像素块和交互图表。每个作家写作的习惯不同，画出来的「指纹」也就不一样——于是你就能直观地看到他们风格的差异。

本项目把它做成了一个开箱即用的网页工具：基于 Python 计算 + D3.js 交互图表，全程可视化操作。

### 能做什么？

- **分析自己的书**：上传任意一部英文小说（`.txt`），几秒钟生成它的「文学指纹」。
- **和名著对比**：与内置的 4 本示例名著（马克·吐温、杰克·伦敦各两本）并列对比。
- **层层下钻**：拖拽、点击、悬停，一路深入到具体段落，看这本书的高潮在哪、哪段最特别。
- **留存自己的分析**：勾选「存入我的图书馆」，上传的派生指纹会保存为 `data/library/*.json`，刷新后仍在，可随时用书名旁的 ✕ 删除（内置示例书不可删，重名会自动改名、不会覆盖）。
- **出处定位与复制**：每个数据点都标注「第 X/N 块 · 约全书 Y% · 本块词数」，可一键复制原文片段用于写作引用。
- **带范围的解读**：指标提示给出按当前已加载书籍算出的参考区间（随数据变化），Honoré 等指标附「宜同尺度横比」的提醒，避免把裸数字当绝对标准。

### 适合谁？

文学研究者、语言学习者、读书爱好者，以及任何想「用数据看文学」的人——**全程不需要写任何代码**。

## 🌐 在线体验（无需本地安装）

已部署的云端演示站，常驻在线、无需冷启动，浏览器直接打开：

- **在线演示：** <http://39.96.194.197/visualization>

> 注：在线演示版会把上传的文本发送到云端服务器处理；只有勾选「存入我的图书馆」才把派生结果写入服务器磁盘（重新部署可能被清空）。若在意隐私，请使用本地版（见下方「基本使用步骤」）。

## 🚀 基本使用步骤

1. **启动**：双击 `start.bat`。
2. **等待**：脚本会自动准备示例数据（首次运行约 1-2 分钟），然后自动打开浏览器。若页面还没加载出来，稍等几秒刷新一次。
3. **看示例**：页面顶部已内置 4 本名著，直接点击书名即可查看它们的指纹。
4. **分析自己的书**：点顶部的「上传文本分析」，选一个英文 `.txt` 文件，几秒后它就会出现在书名列表里，和示例书并列对比。想留档就在「上传」旁勾选「存入我的图书馆」（本地版默认勾选，在线演示默认不勾）——之后刷新页面它仍在。

## 👀 怎么看这些图

1. **选书**：顶部点书名（可一次点多本），图表会自动变成多本书并排对比。
2. **看局部**：在右下角「趋势演变」图上按住鼠标左键左右拖拽，选出一段（比如某个章节），左边所有图会立刻只显示这一段的数据。
3. **看细节**：点任意柱子或线条，右侧会弹出这本书在这一段里数值最高的 3 个段落，附原文片段和关键词。
4. **排序与高亮**：点图表标题旁的排序图标可切换排序；鼠标悬停任一元素，相关的书会被高亮、其余自动变暗。

## 📊 这些指标是什么意思

- **平均句长（Average Sentence Length）**：一句话平均多少个单词，数值越大句子越长、越书面。
- **辛普森指数（Simpson's Index）**：词汇丰富度，越接近 0 用词越丰富，越接近 1 越重复。
- **Honoré 词汇丰富度 R（字段名仍为 Hapax Legomena）**：由词元总数 N、不同词型数 V 和只出现一次的词型数 V1 综合计算，当前实现公式为 `R = 100 × ln(N) / (1 - V1/V)`。它通常不是 0–1 的比例；数值越高，一般表示词汇使用越丰富。
- **功能词 PCA（Function Words PCA）**：看「的 / 和 / 是」这类高频小词的使用习惯，反映语法风格。

## ⚠️ 注意事项

- **只支持英文文本**：目前算法按英文设计，中文等其他语言的结果不可靠。
- **文件格式**：请用 `.txt` 纯文本，UTF-8 编码。
- **文本长度**：正文至少约 1 万词，建议几万字——书越长，趋势图越丰富；太短会无法生成指纹。
- **首次运行较慢**：第一次启动要生成示例数据，约 1-2 分钟，之后秒开。
- **页面打不开**：若浏览器没自动打开或页面空白，稍等几秒刷新；若仍不行，可能是 5000 端口被占用，关闭占用程序后重试。
- **隐私与留存**：上传属于即时分析。只有勾选「存入我的图书馆」后，派生指标与片段预览（长片段预览可大段覆盖原文）才会写入当前服务器的 `data/library/`：本地版默认勾选（本机留档），在线演示默认不勾（不落盘，重新部署还会清空）。内置示例书永不会被覆盖或删除。当前在线演示使用 HTTP，不应视为加密传输，请勿上传敏感、私密或未获授权的文本。

## 🛠️ 进阶（写给开发者）

技术栈：Python（Flask / NLTK / scikit-learn）+ D3.js 前端。

### 项目结构

```text
Literature-Fingerprinting/
├── data/                               # 数据存储
│   ├── raw/                            # 原始小说文本 (.txt)
│   ├── library/                        # 「我的图书馆」(用户勾选保存的派生 JSON，不入库)
│   └── processed/                      # 预处理后的 JSON 数据 (供前端 API 调用)
├── src/                                # Python 核心逻辑
│   ├── __init__.py
│   ├── data_loader.py                  # 文本清洗与滑动窗口切分
│   ├── metrics.py                      # 核心指标计算 (句长、Simpson、Hapax、PCA)
│   ├── pipeline.py                     # 共享数据处理管线 (批量生成与上传分析复用)
│   ├── visualizer.py                   # Matplotlib 静态绘图 (用于 Streamlit)
│   └── analyzer.py                     # 统计分析与异常检测模块
├── static/                             # D3.js 前端资源
│   ├── css/
│   │   └── d3-style.css                # 仪表盘样式表
│   └── js/
│       └── d3-charts.js                # D3.js 核心绘图与交互逻辑 (含 Dashboard)
├── tests/                              # 单元测试
│   ├── test_metrics.py                 # 指标计算测试
│   └── test_api.py                     # 书库/命名去重/删除保护等 API 契约测试
├── app.py                              # Streamlit 经典版入口 (参数调优工作台，已归档/实验性)
├── api_server.py                       # Flask API 服务器 (D3 版入口)
├── generate_data.py                    # 批处理脚本 (Raw Text -> JSON)
├── d3_visualization.html               # D3 可视化主页面 HTML
├── requirements.txt                    # 项目依赖
└── start.bat                           # 快速启动
```

### 本地开发

环境要求：Python 3.10+（开发与测试环境为 Python 3.13）。

```bash
# 1. 克隆项目
git clone [repository_url]
cd Literature-Fingerprinting

# 2. 安装依赖
pip install -r requirements.txt

# 3. (可选) NLTK 数据包会自动下载，如遇网络问题可手动运行：
# python -c "import nltk; nltk.download('punkt'); nltk.download('stopwords')"
```

**手动启动**：预生成示例数据（服务器在首次请求时也会自动生成）：

```bash
python generate_data.py
```

再启动 API 服务器，然后访问 <http://localhost:5000/visualization>：

```bash
python api_server.py
```

**运行测试**（指标 + 书库 API 全套）：

```bash
python -m unittest discover -s tests -v
```

**删除「我的图书馆」里的书**：删除需要保存时签发的令牌（存在保存它的浏览器里），
本机也一样——`Host` 头是客户端说了算的，拿它当删除授权等于没授权。
清过浏览器数据、又想删掉本机的旧文件时，可以显式开启本机豁免：

```bash
# Windows (cmd)
set ALLOW_LOCAL_DELETE=1 && python api_server.py
# macOS / Linux / Git Bash
ALLOW_LOCAL_DELETE=1 python api_server.py
```

或者直接删掉 `data/library/<书名>.json`。

**Streamlit 经典模式**（⚠️ 已归档，仅作实验性参考；正式产品为上方 D3 版，新用户无需关注）：

```bash
streamlit run app.py
```

### 参考资料

1. Keim, D. A., & Oelke, D. (2007). *Literature Fingerprinting: A New Method for Visual Literary Analysis*.
2. D3.js Gallery & Documentation.
3. Project Gutenberg (Text Source).

## 🗑️ 变更记录：Streamlit 经典版已从仓库移除（2026-09-27）

上面「项目结构」与「本地开发」两节里仍写着 `app.py`、`src/analyzer.py`、
`src/visualizer.py`——那是早期的 Streamlit 版。正式产品是 D3 版，这几个文件在
Flask 路径上一次都不会被加载，属于死代码，已从仓库删除：

| 文件 | 行数 | 原用途 |
| --- | --- | --- |
| `app.py` | 774 | Streamlit 入口 |
| `src/analyzer.py` | 389 | 统计分析与异常检测 |
| `src/visualizer.py` | 61 | Matplotlib 静态绘图 |
| `assets/custom.css` | 239 | 早期遗留的样式表，**从未被任何代码引用**（app.py 的样式是内联写死的） |

合计 1463 行。因此这两节里的相关描述、以及 `streamlit run app.py` 这条命令都已失效；
上面的原文保留下来只作历史记录，不再修改。

顺带说明：那一节的项目结构树本来就比仓库旧一些，不止少了这几个文件——树里没有
`src/projection.py` 和 `src/analysis_utils.py`，`tests/` 少了 `test_data_loader.py`
和 `test_pipeline.py`，根目录也没列 `Dockerfile`、`render.yaml`、`.dockerignore`。
本次只做删除，树本身没有改动。

（行数按 `wc -l` 计。这四个文件末尾都没有换行符，所以 `git diff` 会各多算一行，
显示为 775 / 390 / 62 / 240、合计 1467——两个数说的是同一件事。）

要从 git 历史取回旧版本：

```bash
# 先找到「删除这次提交」的哈希（--diff-filter=D 只列删除）
git log --oneline --diff-filter=D -- app.py
# 再从它之前的那次提交里取回
git checkout <上面查到的哈希>^ -- app.py src/analyzer.py src/visualizer.py assets/custom.css
```

这版需要的 streamlit / pandas / matplotlib / seaborn 四个包（约 250 MB，线上路径
一次都不会 import）已经在上一批依赖精简里从 `requirements.txt` 删掉了（提交
50086de），本次删除文件没有再动清单里的包，只更新了那句说明性注释。
