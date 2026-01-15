# Literature Fingerprinting Program

#### Introduction

This project aims to reproduce and enhance the "Literature Fingerprinting" visualization method proposed by Keim and Oelke. This method segments text into fixed-size blocks, calculates statistical features for each block (e.g., average sentence length, vocabulary richness), and maps them to a pixel grid (Pixel Map) or interactive charts to intuitively display the stylistic differences between different authors.

**Core Upgrade:**
Building upon the original Python analysis engine, we have constructed a new **fully interactive Web visualization system based on D3.js + Flask**. This system not only retains Python's powerful data processing capabilities but also provides a fluid, precise, and multi-dimensional interactive exploratory analysis experience on the Web.

#### Feature Highlights

We have successfully implemented a complete loop from data processing to interactive display:

- **Multi-dimensional Metric Analysis**:
  - **Average Sentence Length**: Measures stylistic complexity.
  - **Simpson's Index**: Measures vocabulary richness.
  - **Hapax Legomena**: Measures vocabulary uniqueness (ratio of words occurring only once).
  - **Function Words PCA**: Principal Component Analysis of function words to reflect grammatical habits.
- **Advanced Comprehensive Analysis Dashboard**:
  - **2x2 Linked Views**: Synchronously displays Mean (Bar), Volatility (Bar), Distribution (Box Plot), and Trend (Line Chart).
  - **Brushing & Linking**: Dragging to select a range on the trend chart updates all other charts in real-time to show statistical features for only the selected segment (enabling dynamic focus from macro to micro).
  - **Linked Highlighting**: Hovering over any element highlights the corresponding book across all views.
  - **Details-on-Demand (Drill-down)**: Clicking on chart elements opens a sidebar displaying the **Top 3 peak text blocks** and their **original text previews** within the current selection.
- **Flexible Comparison Modes**: Supports single selection for details or multi-selection for side-by-side comparison (Small Multiples Heatmap / Multi-line Chart).
- **RESTful API Architecture**: Decoupled frontend and backend, with dynamic data transmission via API.

#### Software Architecture

```
Literature-Fingerprinting/
├── data/                               # Data storage
│   ├── raw/                            # Raw novel text files (.txt)
│   └── processed/                      # Preprocessed JSON data (for frontend API calls)
├── src/                                # Python core logic
│   ├── __init__.py
│   ├── data_loader.py                  # Text cleaning and sliding window segmentation
│   ├── metrics.py                      # Core metric calculations (Mean, Simpson, PCA, etc.)
│   ├── visualizer.py                   # Matplotlib static plotting (for Streamlit)
│   └── analyzer.py                     # Statistical analysis and anomaly detection module
├── static/                             # D3.js frontend resources
│   ├── css/
│   │   └── d3-style.css                # Dashboard stylesheet
│   └── js/
│       └── d3-charts.js                # D3.js core plotting and interaction logic (includes Dashboard)
├── app.py                              # Streamlit classic version entry point
├── api_server.py                       # Flask API server (D3 version entry point)
├── generate_data.py                    # Batch processing script (Raw Text -> JSON)
├── d3_visualization.html               # D3 visualization main page HTML
├── requirements.txt                    # Project dependencies
├── start.bat                           # Quick start script
├── README.en.md                        # Project documentation (English)
└── README.md                           # Project documentation (Chinese)
```

#### Installation

This project is based on Python 3.8+.

```
# 1. Clone the project
git clone [repository_url]
cd Literature-Fingerprinting

# 2. Install dependencies
pip install -r requirements.txt

# 3. (Optional) NLTK data packages will download automatically. If network issues occur, run manually:
# python -c "import nltk; nltk.download('punkt'); nltk.download('stopwords')"
```

#### Startup Instructions

**Recommended: Use D3.js Interactive Mode**

1. **Data Preprocessing** (Required for the first run or after updating text files):
   Calculate fingerprint data for all books and generate JSON files.

   ```
   python generate_data.py
   ```

2. **Start API Server**:
   Start the Flask backend service.

   ```
   python api_server.py
   ```

3. **Access the System**:
   Open your browser and visit: [http://localhost:5000/visualization](https://www.google.com/url?sa=E&q=http%3A%2F%2Flocalhost%3A5000%2Fvisualization)

------



**Alternative: Use Streamlit Classic Mode**
Suitable for quickly checking parameter impacts.

```
streamlit run app.py
```

#### Interaction Guide

1. **Global Filtering & Comparison**:
   - Click book buttons at the top (supports multi-selection); charts below automatically switch to **Small Multiples Heatmap** or **Multi-line Trend Chart**.
   - Click "Jack London" / "Mark Twain" capsules at the top of the dashboard to quickly filter by author.
2. **Brushing**:
   - On the bottom-right **"Trend Evolution"** chart, hold the left mouse button and **drag horizontally**.
   - **Effect**: Creates a gray selection area (e.g., selecting the climax chapters). The Mean, Volatility, and Box Plot charts on the left will **recalculate in real-time** to show data only for that selection.
3. **Drill-down**:
   - Click any bar or line.
   - **Effect**: The right-side **"Drill-down Details"** panel pops up, listing the 3 text blocks with the highest values within the current selection, displaying their original text snippets and keywords. Supports clicking multiple books for **stacked multi-book detail comparison**.
4. **Sorting & Highlighting**:
   - Click the sort icon next to the Mean/Volatility chart titles to switch between **Value Descending** / **Name Ascending**.
   - Hover over any chart element to trigger **global linked highlighting**, dimming other unrelated elements automatically.

#### Experimental Results & Validation

We selected four representative works by Jack London (*The Call of the Wild*, *White Fang*) and Mark Twain (*Tom Sawyer*, *Huckleberry Finn*) for validation.

1. **Style Differences**:
   - **Jack London** (Yellow/Green): Significantly lower in the Mean chart (~15-18 words/sentence) with low volatility, reflecting his concise, forceful, hard-boiled style.
   - **Mark Twain** (Blue/Red): Higher in the Mean chart (~20-25 words/sentence), reflecting his descriptive characteristics.
2. **Anomaly Reproduction (\*Huckleberry Finn\* Anomaly)**:
   - In the D3 dashboard, although the mean value for *Huckleberry Finn* (Red) is close to Twain's level, in **Heatmap** mode, its hue distribution differs significantly from *Tom Sawyer* (Blue), leaning more towards warmer tones.
   - **Explanation**: This successfully reproduces the paper's conclusion—due to the use of a first-person child perspective and oral dialect, the "fingerprint" features of this book shift at the microscopic level.

#### Team Contributions

- **Yikun Wang (Data Engineering)**: Built data_loader.py, implemented the sliding window segmentation algorithm compliant with the paper's standards; assisted in JSON data structure design.
- **Zefan Zhang (Algorithm Implementation)**: Developed metrics.py, implemented core literary statistical algorithms such as Simpson's Index and Hapax Legomena; optimized keyword extraction logic.
- **Yicheng Sun (Full Stack Visual Analysis)**:
  - Built the Flask + D3.js architecture.
  - Implemented advanced interaction logic in d3-charts.js such as **multi-view linking**, **brushing recalculation**, and **dynamic drill-down**.
  - Designed and beautified the frontend UI/UX.

#### References

1. Keim, D. A., & Oelke, D. (2007). *Literature Fingerprinting: A New Method for Visual Literary Analysis*.
2. D3.js Gallery & Documentation.
3. Project Gutenberg (Text Source).