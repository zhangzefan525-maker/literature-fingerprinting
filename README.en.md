# Literature Fingerprinting

#### Introduction

This project aims to reproduce the "Literature Fingerprinting" visualization method proposed by Keim and Oelke. This method involves dividing text into fixed-size blocks, calculating statistical features for each block (such as average sentence length, lexical richness, etc.), and mapping these features into a pixel grid, thereby intuitively demonstrating the differences in writing styles between different authors.

We have built an interactive visual analysis system using Python and Streamlit, which successfully distinguishes the writing styles of Jack London and Mark Twain, and reproduces the key finding in the paper regarding the stylistic anomaly in *The Adventures of Huckleberry Finn*.

#### Software Architecture

```plaintext
Literature-Fingerprinting-Master/
├── data/                               # Stores experimental novel texts (.txt)
│   ├── The call of the wild.txt        # Jack London
│   ├── White Fang.txt                  # Jack London
│   ├── The Adventures of Tom Sawyer.txt      # Mark Twain
│   └── The Adventures of Huckleberry Finn.txt # Mark Twain (for special case verification)
├── src/                                # Source code directory
│   ├── __init__.py
│   ├── data_loader.py                  # [Member A] Data loading and segmentation
│   ├── metrics.py                      # [Member B] Metric calculation algorithms
│   └── visualizer.py                   # [Member C] Plotting logic implementation
├── app.py                              # [Member C] Streamlit frontend main program
├── requirements.txt                    # Project dependency libraries
├── start.bat                         # Windows one-click startup script
└── README.md                           # Project description document
```

#### Installation Tutorial

This project is developed based on Python 3.8+. Please ensure that a Python environment is installed.

```bash
# 1. Clone or download this project
# 2. Install dependency libraries
pip install -r requirements.txt

# 3. (Optional) NLTK data packages will be downloaded automatically. If encountering network issues, run manually:
# python -c "import nltk; nltk.download('punkt'); nltk.download('stopwords')"
```

### Startup Methods

#### Method 1: One-click startup using the script (recommended)

Double-click `start.bat` in the project root directory to automatically open the browser.

#### Method 2: Command line startup

Run the following command in the terminal:

```bash
streamlit run app.py --server.port 8502
```

#### Usage Instructions

### 5.1 Data Processing

- **Segmentation Strategy**: Following the standards of the original paper, the entire novel is divided into text blocks (Blocks) containing 10,000 words, with a step size of 1,000 words, i.e., an overlap of 9,000 words. This ensures the smoothness and continuity of the visualization.

### 5.2 Visualization Mapping

- **Pixel Layout**: Arrange the one-dimensional sequence of text blocks into a two-dimensional grid (approximately square).

- Color Coding

  : Using the RdBu (red-white-blue) bipolar color spectrum:

  - Red: Represents low values (e.g., short sentences, low lexical diversity)
  - Blue: Represents high values (e.g., long sentences, high lexical diversity)

- **Unified Scale**: For cross-book comparison, we fixed the mapping range for the "average sentence length" metric (vmin=10, vmax=35) to avoid color bias caused by the data distribution of a single book.

## 6. Results & Validation

We selected four representative works by Jack London and Mark Twain for validation, and the experimental results successfully reproduced the conclusions of the paper.

### 6.1 Style Difference Verification

| Author      | Work                           | Visualization Performance | Style Analysis                                               |
| ----------- | ------------------------------ | ------------------------- | ------------------------------------------------------------ |
| Jack London | *The Call of the Wild*         | Overall red tone          | Concise, forceful short sentence style (average sentence length about 15-18 words) |
| Mark Twain  | *The Adventures of Tom Sawyer* | Overall blue tone         | Complex, descriptive long sentence style (average sentence length about 20-25 words) |

### 6.2 Key Anomaly Reproduction (The "Huckleberry Finn" Anomaly)

- **Object**: Mark Twain's *The Adventures of Huckleberry Finn*
- **Result**: Despite being by Twain, the heatmap shows large red areas similar to London's works
- **Conclusion**: This perfectly reproduces the core finding of the paper — due to the book's first-person (child's perspective) and extensive use of colloquial dialects, its "literary fingerprint" actually deviates from Twain's usual style and is closer to a concise style. This demonstrates that our visualization system can deeply reveal the intrinsic properties of texts.

## 7. Interactive Features

1. **Parameter Adjustment**: Allows users to customize Block Size and Overlap to explore visualization effects at different granularities.
2. **Block Inspector**: An interactive probe is implemented on the right side of the frontend; users can drag the slider to locate specific pixels and view the original text fragment and specific values corresponding to the text block.
3. **Unified Scale Control**: Supports enabling/disabling Unified Scale, flexibly switching between "single-book comparison" and "cross-book comparison" modes.

#### Contribution

This project is completed by a three-person team, with a clear code structure and high modularity.

### Member A (Data Processing)

- Responsible for `src/data_loader.py`
- Implemented `load_clean_text` and `get_blocks` interfaces
- Completed text cleaning, word segmentation, and the "sliding window" segmentation algorithm as required by the paper (Block Size=10000, Overlap=9000)

### Member B (Core Algorithms)

- Responsible for `src/metrics.py`
- Implemented various text feature calculation algorithms, including:
  - Average Sentence Length
  - Simpson's Index (lexical diversity)
  - Hapax Legomena (number of words appearing only once)
  - PCA analysis based on function words
- Configured the `requirements.txt` dependency environment

### Member C (Visualization and Frontend Integration)

- Responsible for `src/visualizer.py` and `app.py`
- Designed heatmap drawing logic based on Seaborn and Matplotlib, implemented adaptive grid layout and bipolar color spectrum mapping
- Built the Streamlit interactive web application, integrating modules from Member A and B
- Implemented interactive detail viewing (Block Inspector) and Unified Scale control

## 8. References

1. Keim, D. A., & Oelke, D. (2007). *Literature Fingerprinting: A New Method for Visual Literary Analysis*. IEEE Symposium on Information Visualization.
2. Streamlit Documentation: https://docs.streamlit.io/
3. NLTK Documentation: https://www.nltk.org/

#### Special Features

1. Use Readme_XXX.md to support different languages, such as Readme_en.md, Readme_zh.md
2. Gitee official blog [blog.gitee.com](https://blog.gitee.com/)
3. You can visit https://gitee.com/explore to learn about excellent open-source projects on Gitee
4. [GVP](https://gitee.com/gvp) stands for Gitee Most Valuable Open-Source Project, which are excellent open-source projects evaluated comprehensively
5. Gitee official user manual https://gitee.com/help
6. Gitee Cover Characters is a column showcasing the demeanor of Gitee members https://gitee.com/gitee-stars/