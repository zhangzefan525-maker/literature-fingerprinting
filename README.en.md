# Literature Fingerprinting

#### Introduction

This project aims to replicate the "Literature Fingerprinting" visualization method proposed by Keim and Oelke. This method involves segmenting text into fixed-size blocks, calculating statistical features for each block (e.g., average sentence length, vocabulary richness), and mapping them onto a pixel grid (Pixel Map) to visually demonstrate the stylistic differences between different authors.

**v2.0 Update:** Building upon our original Streamlit analysis system, we have added a new Web visualization module based on **D3.js + Flask**. This enhancement combines Python's powerful computational capabilities with the superior frontend interactive experience of D3.js (smooth transitions, dynamic heatmap/line chart switching, SVG export, etc.).

We have successfully implemented:

- **Multi-dimensional Metric Analysis:** Average Sentence Length, Simpson's Index, Hapax Legomena, and Function Words PCA.
- **Dual-mode Visualization:**
  - **Streamlit Version:** Ideal for rapid verification, parameter tuning, and deep statistical analysis.
  - **D3.js Version (New):** Provides web-scale high-performance interaction, supporting mouse-hover tooltips, smooth chart transitions, and dynamic view switching.
- **Deep Analysis Functions:** Style classification, anomaly detection, similarity comparison.
- **RESTful API Support:** Implemented a decoupled architecture with a separate data service backend.

#### Software Architecture

Code

```
Literature-Fingerprinting/
├── data/                               # Directory for novel text files
│   ├── raw/                            # Original text files (.txt)
│   └── processed/                      # [New] Preprocessed JSON data (for D3)
├── src/                                # Source code directory
│   ├── __init__.py
│   ├── data_loader.py                  # [Member A] Data loading and segmentation
│   ├── metrics.py                      # [Member B] Metric calculation algorithms
│   ├── visualizer.py                   # [Member C] Matplotlib/Seaborn plotting logic
│   └── analyzer.py                     # [New] Fingerprint statistical analysis module
├── static/                             # [New] D3.js frontend static resources
│   ├── css/
│   │   └── d3-style.css                # Visualization stylesheet
│   └── js/
│       └── d3-charts.js                # D3.js core plotting logic
├── app.py                              # [Member C] Streamlit main application
├── api_server.py                       # [New] Flask API server (Provides data for D3)
├── generate_data.py                    # [New] Data preprocessing script (Generates JSON)
├── d3_visualization.html               # [New] D3 Visualization entry page
├── requirements.txt                    # Project dependencies
└── README.md                           # Project documentation
```

#### Installation

This project is developed based on Python 3.8+. Please ensure a Python environment is installed.

```
# 1. Clone or download this project
# 2. Install dependencies
pip install -r requirements.txt

# 3. (Optional) NLTK data packages will download automatically. 
# If network issues occur, run manually:
# python -c "import nltk; nltk.download('punkt'); nltk.download('stopwords')"
```

#### Usage / Start-up

The project supports two start-up modes depending on your needs.

### Mode 1: D3.js Interactive Visualization (Recommended Experience)

This is the new advanced visualization mode, supporting smooth animations and finer interactions.

**Step 1: Generate Data**
Run the preprocessing script to calculate all metrics and generate JSON files:

```
python generate_data.py
```

**Step 2: Start API Server**
Start the Flask backend to provide data interfaces:

```
python api_server.py
```

**Step 3: Access**
Open your browser and visit: http://localhost:5000/visualization

------



### Mode 2: Streamlit Analysis Dashboard (Classic Mode)

Suitable for parameter tuning (e.g., adjusting Block Size) and viewing detailed statistical reports.

```
streamlit run app.py
```

#### Feature Description

### 5.1 D3.js New Features

- **View Switching:** Seamlessly switch between **"📈 Line Chart"** and **"▦ Fingerprint Heatmap"** via the dropdown menu.
- **Smart Interaction:**
  - **Tooltip:** Hover over data points or color blocks to see the text block number, specific metric value, and keywords in real-time.
  - **Click Details:** Click on any data point to reveal the **text preview** and **top keywords** in the right-hand panel.
- **Smoothing Control:** Drag the "Smoothness" slider to apply a moving average to the line chart for clearer trend observation.
- **Image Export:** Support one-click export of the current SVG chart as a PNG image.

### 5.2 Data Processing Strategy

- **Segmentation Strategy:** Following the original paper's standard, the entire novel is sliced into text blocks containing 10,000 words each, with a step size of 1,000 words (i.e., an overlap of 9,000 words).
- **Visualization Mapping:**
  - **Heatmap:** Uses D3's interpolateRdBu diverging color scale (auto-normalized). Red represents low values, and Blue represents high values.
  - **Adaptive Layout:** The frontend automatically calculates the optimal number of grid rows and columns (approximating a square layout).

## 6. Results & Validation

We selected four representative works by Jack London and Mark Twain for validation.

### 6.1 Style Difference Verification

| Author      | Work                           | Visualization Appearance | Style Analysis                                               |
| ----------- | ------------------------------ | ------------------------ | ------------------------------------------------------------ |
| Jack London | *The Call of the Wild*         | Predominantly Red        | Concise, punchy short sentences (Avg length ~15-18 words)    |
| Mark Twain  | *The Adventures of Tom Sawyer* | Predominantly Blue       | Complex, descriptive long sentences (Avg length ~20-25 words) |

### 6.2 The "Huckleberry Finn" Anomaly

- **Subject:** *The Adventures of Huckleberry Finn* by Mark Twain
- **Result:** In the D3 Heatmap, this book displays distinct warm tones (Red/Light colors), contrasting sharply with Twain's other work, *Tom Sawyer*.
- **Conclusion:** This perfectly replicates the paper's finding — the use of a child's first-person perspective and extensive oral dialect causes the "fingerprint" of this work to deviate from Twain's usual style, appearing closer to a concise style.

#### Contribution

This project was completed through the collaboration of a three-person team:

### Member A (Data Processing)

- Responsible for data_loader.py, implemented the sliding window segmentation algorithm.
- **New:** Assisted in adapting JSON data formats to ensure backend-frontend data compatibility.

### Member B (Core Algorithms)

- Responsible for metrics.py, implemented core algorithms including Average Sentence Length, Simpson's Index, and PCA.
- **New:** Optimized keyword extraction algorithms to provide data support for frontend Tooltips.

### Member C (Full Stack & Integration)

- Responsible for visualizer.py (Matplotlib) and app.py (Streamlit).
- **New:** Introduced the **Flask + D3.js** tech stack.
- **New:** Wrote api_server.py to build the RESTful API.
- **New:** Developed frontend pages (.html, .css, .js), implementing dynamic heatmaps and interaction logic.

## 8. References

1. Keim, D. A., & Oelke, D. (2007). *Literature Fingerprinting: A New Method for Visual Literary Analysis*. IEEE Symposium on Information Visualization.
2. D3.js Documentation: [https://d3js.org/](https://www.google.com/url?sa=E&q=https%3A%2F%2Fd3js.org%2F)
3. Flask Documentation: [https://flask.palletsprojects.com/](https://www.google.com/url?sa=E&q=https%3A%2F%2Fflask.palletsprojects.com%2F)
4. Streamlit Documentation: [https://docs.streamlit.io/](https://www.google.com/url?sa=E&q=https%3A%2F%2Fdocs.streamlit.io%2F)