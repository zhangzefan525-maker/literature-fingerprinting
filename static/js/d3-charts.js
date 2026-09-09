// static/js/d3-charts.js

// API配置（同源部署：本地与 Render 均使用空路径，自动指向当前站点）
const API_BASE_URL = '';
const API_ENDPOINTS = {
    fingerprintData: `${API_BASE_URL}/api/fingerprint-data`,
    books: `${API_BASE_URL}/api/books`
};

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
const DEFAULT_UPLOAD_STATUS = '支持上传英文 .txt 纯文本（建议 ≥1 万词），自动生成文学指纹并与示例书籍并列对比。';

// 全局变量
let realData = null;
let currentMetric = 'sentenceLength';
let selectedBooks = new Set();
let smoothness = 3;
let chartType = 'heatmap';
let currentTab = 'view-main'; // 记录当前标签页

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    initEventListeners();
    updateChartTypeUI();
    setUploadStatus(`${DEFAULT_UPLOAD_STATUS} ${getUploadPrivacyNotice()}`);
    updateMetricHint();
    loadBooksList();

    setTimeout(() => {
        toggleMatrixRain();
    }, 500);
});

function getUploadPrivacyNotice() {
    const hostname = window.location.hostname;
    if (LOCAL_HOSTNAMES.has(hostname)) {
        return '当前为本机访问：文件会发送到本机 Flask 服务即时处理，应用代码不会主动保存上传的原文。';
    }
    return '当前为远程访问：文件会发送到当前服务器即时处理，请勿上传敏感、私密或未获授权的文本。在线演示使用 HTTP，不应视为加密传输。';
}

function setUploadStatus(message, state = '') {
    const statusEl = document.getElementById('upload-status');
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = `upload-status${state ? ` ${state}` : ''}`;
}

function setUploadBusy(isBusy) {
    const bar = document.getElementById('upload-bar');
    const fileInput = document.getElementById('file-upload');
    const uploadBtn = document.getElementById('upload-btn');
    if (bar) bar.setAttribute('aria-busy', String(isBusy));
    if (fileInput) fileInput.disabled = isBusy;
    if (uploadBtn) {
        uploadBtn.setAttribute('aria-disabled', String(isBusy));
        uploadBtn.classList.toggle('is-busy', isBusy);
    }
}

function getErrorMessage(response, result) {
    if (response.status === 413) {
        return '文件太大，单个文件不能超过 50 MB。请选择较小的 .txt 文件后重试。';
    }
    if (result && result.message) return result.message;
    if (!response.ok) return `服务器暂时无法完成分析（HTTP ${response.status}），请稍后重试。`;
    return '服务器返回了无法识别的结果，请稍后重试。';
}

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function truncateText(value, length = 18) {
    const text = String(value ?? '');
    return text.length > length ? text.substring(0, length - 3) + '...' : text;
}

function formatMetricValue(value, digits = 2) {
    return isFiniteNumber(value) ? value.toFixed(digits) : '暂无';
}

function getMetricValues(bookName, metric) {
    const values = realData && realData[bookName] ? realData[bookName][metric] : null;
    if (!Array.isArray(values)) return [];
    return values.filter(d => d && isFiniteNumber(d.value));
}

function getBookButtonById(bookId) {
    return Array.from(document.querySelectorAll('.book-btn'))
        .find(btn => btn.dataset.id === bookId) || null;
}

function normalizeExtent(extent, fallback = 0) {
    let [min, max] = extent;
    if (!isFiniteNumber(min) || !isFiniteNumber(max)) return [fallback - 1, fallback + 1];
    if (min === max) return [min - 1, max + 1];
    return [min, max];
}

function getDeterministicFallbackY(bookIndex, blockIndex) {
    return (bookIndex + 1) * 0.01 + ((blockIndex % 11) - 5) * 0.001;
}


// Tab 切换逻辑
window.switchTab = function(tabId) {
    currentTab = tabId;

    // 同步 tab/tabpanel 语义，让键盘和读屏用户知道当前视图
    document.querySelectorAll('.tab-btn').forEach(btn => {
        const isActive = btn.getAttribute('aria-controls') === tabId;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', String(isActive));
        btn.setAttribute('tabindex', isActive ? '0' : '-1');
    });

    document.querySelectorAll('.view-section').forEach(section => {
        const isActive = section.id === tabId;
        section.classList.toggle('active', isActive);
        section.hidden = !isActive;
    });

    const activeSection = document.getElementById(tabId);
    if (activeSection) {
        // 延迟一点点以确保 DOM 布局已更新
        setTimeout(() => {
            if (tabId === 'view-main' && realData) {
                initChart();
            } else if (tabId === 'view-galaxy' && realData) {
                initStyleGalaxy();
            } else if (tabId === 'view-dashboard' && realData) {
                if (window.initAdvancedData) window.initAdvancedData();
            }
        }, 50);
    }
};

// 初始化事件监听器
function initEventListeners() {
    // 指标选择
    document.getElementById('metricSelect').addEventListener('change', function(e) {
        currentMetric = e.target.value;
        updateMetricHint();
        if (realData) {
            // 数据变化时，更新所有图表
            refreshAllActiveCharts();
        }
    });
    
    // 平滑度调整
    document.getElementById('smoothness').addEventListener('input', function(e) {
        smoothness = parseInt(e.target.value);
        if (realData) {
            initChart();
        }
    });
    
    // 导出图像
    document.getElementById('exportBtn').addEventListener('click', exportChart);
    const exportSummaryBtn = document.getElementById('exportSummaryBtn');
    if (exportSummaryBtn) exportSummaryBtn.addEventListener('click', exportSummary);

    // 新增：图表类型切换监听
    document.getElementById('chartTypeSelect').addEventListener('change', function(e) {
        chartType = e.target.value;
        updateChartTypeUI();
        if (realData) {
            initChart();
        }
    });

    // 上传自定义文本
    const fileInput = document.getElementById('file-upload');
    if (fileInput) fileInput.addEventListener('change', handleFileUpload);
}

// 根据当前图表类型（热力图 / 折线图）控制「曲线平滑」与「多书对比」控件的显隐
// 热力图是像素块，没有曲线可平滑，也不支持折线多书对比，故仅折线图下显示
function updateChartTypeUI() {
    const compareBtn = document.getElementById('toggleComparison');
    const smoothnessGroup = document.getElementById('smoothnessGroup');
    const isHeatmap = chartType === 'heatmap';

    if (compareBtn) {
        compareBtn.style.display = isHeatmap ? 'none' : 'block';
    }
    if (smoothnessGroup) {
        smoothnessGroup.style.display = isHeatmap ? 'none' : 'flex';
    }
}

// 上传自定义文本并即时分析
async function handleFileUpload(event) {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.txt')) {
        setUploadStatus('仅支持 .txt 文本文件。请重新选择 UTF-8 编码的英文纯文本。', 'error');
        input.value = '';
        return;
    }

    setUploadBusy(true);
    setUploadStatus(`正在分析「${file.name}」（长文本可能需要一会儿），请勿关闭页面...`, 'loading');

    const formData = new FormData();
    formData.append('file', file);

    try {
        const resp = await fetch(`${API_BASE_URL}/api/analyze`, { method: 'POST', body: formData });
        const contentType = resp.headers.get('content-type') || '';
        const result = contentType.includes('application/json') ? await resp.json() : null;

        if (!resp.ok || !result || result.status !== 'success') {
            setUploadStatus(getErrorMessage(resp, result), 'error');
            return;
        }

        if (!realData) realData = {};
        realData[result.book] = result.data;
        selectedBooks.add(result.book);
        addUploadedBookButton(result.book);
        const nBlocks = result.data && result.data.metadata ? result.data.metadata.totalBlocks : 0;
        setUploadStatus(`已加载「${getBookDisplayName(result.book)}」（${nBlocks} 个文本块）。${getUploadPrivacyNotice()}`, 'success');
        refreshAllActiveCharts();
    } catch (e) {
        console.error('上传分析失败:', e);
        setUploadStatus('上传失败：无法连接当前分析服务。请确认服务器已启动，或稍后重试。', 'error');
    } finally {
        setUploadBusy(false);
        input.value = ''; // 允许重复上传同一文件
    }
}

// 将上传的书动态加入选择器，并保持选中态
function addUploadedBookButton(bookName) {
    const selector = document.getElementById('bookSelector');
    if (!selector) return;
    if (getBookButtonById(bookName)) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'book-btn active';
    button.setAttribute('data-id', bookName);
    button.title = bookName;
    button.textContent = getBookDisplayName(bookName);
    button.addEventListener('click', () => selectBook(bookName));
    selector.appendChild(button);
}

// 辅助函数：根据当前 Tab 刷新图表
function refreshAllActiveCharts() {
    if (currentTab === 'view-main') initChart();
    if (currentTab === 'view-galaxy') initStyleGalaxy();
    if (currentTab === 'view-dashboard' && window.initAdvancedData) window.initAdvancedData();
}

// 响应式：窗口尺寸变化时防抖重绘当前图表，保证手机横竖屏切换后图表尺寸正确
let resizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (realData) refreshAllActiveCharts();
    }, 250);
});

// 加载书籍列表
async function loadBooksList() {
    try {
        const response = await fetch(API_ENDPOINTS.books);
        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json') ? await response.json() : null;

        if (!response.ok || !data || data.status !== 'success') {
            const message = getErrorMessage(response, data);
            console.error('加载书籍列表失败:', message);
            showError(`无法加载书籍列表：${message}`);
            return;
        }

        updateBookSelector(data.books);
        if (!data.books || data.books.length === 0) {
            showNoDataMessage();
            return;
        }
        loadRealData(); // 打开页面即自动加载数据并出图
    } catch (error) {
        console.error('网络错误:', error);
        showError('无法连接到当前分析服务。请确保已运行 python api_server.py，或稍后重试。');
    }
}

function updateBookSelector(books) {
    const selector = document.getElementById('bookSelector');
    if (!selector) return;
    if (!books || books.length === 0) {
        selector.innerHTML = '<p class="state-card empty">没有找到任何书籍。请将 .txt 文件放入 data/raw，或直接上传文本。</p>';
        return;
    }

    selector.innerHTML = '';
    books.forEach(book => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'book-btn';
        button.dataset.id = book.id;
        button.title = book.name || book.id;
        button.textContent = getBookDisplayName(book.name || book.id);
        button.addEventListener('click', () => selectBook(book.id));
        selector.appendChild(button);
    });

    // 默认选中第一本书
    selectBook(books[0].id);
}

function selectBook(bookId) {
    const btn = getBookButtonById(bookId);

    if (selectedBooks.has(bookId)) {
        const btn = getBookButtonById(bookId);
        if (selectedBooks.size > 1) {
            selectedBooks.delete(bookId);
            if (btn) btn.classList.remove('active');
        }
    } else {
        // 如果未选中，则添加
        selectedBooks.add(bookId);
        if (btn) btn.classList.add('active');
    }

    // 更新对比状态提示文字
    const compareBtn = document.getElementById('toggleComparison');
    if (compareBtn) {
        if (selectedBooks.size > 1) {
            compareBtn.textContent = `📚 已选 ${selectedBooks.size} 本书进行对比`;
        } else {
            compareBtn.textContent = '⇄ 点击上方书名可多选进行对比';
        }
    }
    
    // 刷新当前可见的图表
    if (realData) {
        refreshAllActiveCharts();
    }
}

async function loadRealData() {
    try {
        showLoading('正在加载数据...');

        const response = await fetch(API_ENDPOINTS.fingerprintData);
        const contentType = response.headers.get('content-type') || '';
        const data = contentType.includes('application/json') ? await response.json() : null;
        if (!response.ok || !data || data.status !== 'success') {
            showError(`加载数据失败：${getErrorMessage(response, data)}`);
            return;
        }

        realData = data.data && typeof data.data === 'object' ? data.data : {};
        const availableBooks = Object.keys(realData);
        if (availableBooks.length === 0) {
            showNoDataMessage();
            return;
        }
        showSuccess(`成功加载 ${availableBooks.length} 本书籍的数据`);

        // 确保 selectedBooks 中的书在数据中存在
        selectedBooks = new Set(Array.from(selectedBooks).filter(book => availableBooks.includes(book)));
        if (selectedBooks.size === 0) {
            selectBook(availableBooks[0]); // 如果没选，默认选第一本
        } else {
            refreshAllActiveCharts();
        }
    } catch (error) {
        console.error('加载数据失败:', error);
        showError('无法加载数据，请检查分析服务是否运行。');
    }
}

// 修改原 initChart，只在 Main Tab 激活时工作
function initChart() {
    // 如果不在主视图，不进行渲染，节省性能
    if (currentTab !== 'view-main') return;

    const svg = d3.select("#main-chart");
    svg.selectAll("*").remove();

    if (!realData || selectedBooks.size === 0) {
        showNoDataMessage();
        return;
    }

    const booksArray = Array.from(selectedBooks);

    // 确保 SVG 容器有宽度 (D3 在 display:none 时宽度为 0)
    const container = svg.node().parentNode;
    if (container.clientWidth === 0) return;

    if (chartType === 'heatmap') {
        drawMultiHeatmap(svg, booksArray);
    } else {
        drawMultiLineChart(svg, booksArray);
    }
}

function drawMultiLineChart(svg, booksArray) {
    const chartData = booksArray.map(bookId => ({
        book: bookId,
        values: getMetricValues(bookId, currentMetric)
    })).filter(d => d.values.length > 0);

    if (chartData.length === 0) { showNoDataMessage(); return; }

    const containerWidth = svg.node().parentNode.getBoundingClientRect().width;
    const height = 400;
    const margin = { top: 40, right: 120, bottom: 50, left: 60 }; 
    const width = containerWidth - margin.left - margin.right;

    svg.attr("viewBox", `0 0 ${containerWidth} ${height}`);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const maxBlocks = d3.max(chartData, d => d.values.length - 1);
    const allValues = chartData.flatMap(d => d.values.map(v => v.value));
    const extent = d3.extent(allValues);
    let yMin = extent[0] * 0.95;
    let yMax = extent[1] * 1.05;
    if (!isFiniteNumber(yMin) || !isFiniteNumber(yMax) || yMin === yMax) {
        const center = isFiniteNumber(extent[0]) ? extent[0] : 0;
        yMin = center - 1;
        yMax = center + 1;
    }

    const xScale = d3.scaleLinear().domain([0, maxBlocks]).range([0, width]);
    const yScale = d3.scaleLinear().domain([yMin, yMax]).range([height - margin.top - margin.bottom, 0]);

    const colorScale = d3.scaleOrdinal(['#b5472f', '#4f7a8c', '#6b8f5a', '#a67c3d', '#5a6b8c', '#a2546b', '#8c6f4a', '#5f7d72']).domain(booksArray);

    const chartHeight = height - margin.top - margin.bottom;
    g.append("g").attr("transform", `translate(0,${chartHeight})`).call(d3.axisBottom(xScale));
    g.append("g").call(d3.axisLeft(yScale));
    
    g.append("g").attr("class", "grid").call(d3.axisLeft(yScale).tickSize(-width).tickFormat("")).attr("stroke-opacity", 0.1);

    // 坐标轴标签：X 为阅读进度（文本块），Y 为当前指标中文名
    g.append("text")
        .attr("class", "axis-label")
        .attr("x", width / 2)
        .attr("y", chartHeight + 38)
        .attr("text-anchor", "middle")
        .text("阅读进度（文本块，约 1 万词 / 块）");

    g.append("text")
        .attr("class", "axis-label")
        .attr("transform", "rotate(-90)")
        .attr("x", -chartHeight / 2)
        .attr("y", -46)
        .attr("text-anchor", "middle")
        .text(getMetricLabel(currentMetric));

    const line = d3.line()
        .x((d, i) => xScale(i))
        .y(d => yScale(d.value))
        .curve(d3.curveMonotoneX);

    chartData.forEach(bookData => {
        const smoothed = smoothData(bookData.values, smoothness);
        
        g.append("path")
            .datum(smoothed)
            .attr("fill", "none")
            .attr("stroke", colorScale(bookData.book))
            .attr("stroke-width", 2.5)
            .attr("d", line)
            .style("opacity", 0.8)
            .on("mouseover", function() { d3.select(this).attr("stroke-width", 5); })
            .on("mouseout", function() { d3.select(this).attr("stroke-width", 2.5); });
            
        const safeBookID = getBookSafeId(bookData.book);

        g.selectAll(`.point-${safeBookID}`)
            .data(bookData.values) 
            .enter()
            .append("circle")
            .attr("class", `data-point point-${safeBookID}`)
            .attr("cx", (d, i) => xScale(i))
            .attr("cy", d => yScale(d.value))
            .attr("r", 3) 
            .attr("fill", colorScale(bookData.book))
            .attr("stroke", "#fdfaf3")
            .attr("stroke-width", 1.5)
            .attr("tabindex", 0)
            .attr("role", "button")
            .attr("aria-label", d => `${getBookDisplayName(bookData.book)} 第 ${d.block + 1} 个文本块，${getMetricLabel(currentMetric)} ${formatMetricValue(d.value)}`)
            .style("cursor", "pointer")
            .style("opacity", 0) 
            .on("mouseover", function(event, d) {
                d3.select(this)
                    .style("opacity", 1)
                    .transition().duration(100)
                    .attr("r", 6)
                    .attr("stroke", "#b5472f")
                    .attr("stroke-width", 2);
                
                showTooltip(event, d, bookData.book);
            })
            .on("mouseout", function(event, d) {
                d3.select(this)
                    .transition().duration(200)
                    .attr("r", 3)
                    .attr("stroke", "#fdfaf3")
                    .attr("stroke-width", 1.5)
                    .style("opacity", 0); 
                
                hideTooltip();
            })
            .on("click", function(event, d) {
                event.stopPropagation();
                d3.selectAll(".data-point").attr("r", 3).style("opacity", 0);
                d3.select(this).style("opacity", 1).attr("r", 8).attr("stroke", "#b5472f");
                showDetail(d, bookData.book);
            })
            .on("keydown", function(event, d) {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    showDetail(d, bookData.book);
                }
            });
    });

    const legend = svg.append("g").attr("transform", `translate(${width + 20}, ${margin.top})`);
    chartData.forEach((d, i) => {
        const row = legend.append("g").attr("transform", `translate(0, ${i * 25})`);
        row.append("rect").attr("width", 15).attr("height", 15).attr("fill", colorScale(d.book));
        row.append("text").attr("x", 20).attr("y", 12).text(getBookDisplayName(d.book)).style("font-size", "12px").style("fill", "#6f6557");
    });
    
    svg.append("text")
        .attr("x", containerWidth / 2)
        .attr("y", 25)
        .attr("text-anchor", "middle")
        .style("font-size", "16px")
        .style("font-weight", "bold")
        .style("fill", "#2f2a23")
        .text(`${getMetricLabel(currentMetric)} - 对比分析`);
}

function drawMultiHeatmap(svg, booksArray) {
    const chartData = booksArray.map(bookId => ({
        book: bookId,
        values: getMetricValues(bookId, currentMetric)
    })).filter(d => d.values.length > 0);

    if (chartData.length === 0) {
        showNoDataMessage();
        return;
    }

    const containerWidth = svg.node().parentNode.getBoundingClientRect().width;
    const padding = 20;
    const topMargin = 80;
    const bottomMargin = 50;

    const chartWidth = (containerWidth - 60 - (chartData.length - 1) * padding) / chartData.length;

    let maxRows = 0;
    let finalBlockSize = 0;

    chartData.forEach(bookData => {
        const n = bookData.values.length;
        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        const blockSize = Math.max(1, Math.floor(chartWidth / cols));

        if (rows > maxRows) maxRows = rows;
        if (finalBlockSize === 0) finalBlockSize = blockSize;
    });

    const totalHeight = Math.max(400, topMargin + (maxRows * finalBlockSize) + bottomMargin);

    svg.attr("viewBox", `0 0 ${containerWidth} ${totalHeight}`)
       .style("height", totalHeight + "px");

    const allVals = chartData.flatMap(bookData => bookData.values.map(d => d.value));
    const extent = d3.extent(allVals);
    let globalMin = extent[0];
    let globalMax = extent[1];
    if (!isFiniteNumber(globalMin) || !isFiniteNumber(globalMax)) {
        globalMin = 0;
        globalMax = 1;
    }
    if (globalMin === globalMax) {
        globalMin -= 1;
        globalMax += 1;
    }

    const colorScale = d3.scaleSequential()
        .interpolator(d3.piecewise(d3.interpolateRgb, ["#2c4a6e", "#f2e7cd", "#a0221a"]))
        .domain([globalMin, globalMax]);

    chartData.forEach((bookData, index) => {
        const bookId = bookData.book;
        const data = bookData.values;

        const g = svg.append("g")
            .attr("transform", `translate(${30 + index * (chartWidth + padding)}, ${topMargin})`);

        const n = data.length;
        const cols = Math.ceil(Math.sqrt(n));
        const blockSize = Math.max(1, Math.floor(chartWidth / cols));

        g.selectAll("rect")
            .data(data)
            .enter()
            .append("rect")
            .attr("class", "heatmap-rect")
            .attr("x", (d, i) => (i % cols) * blockSize)
            .attr("y", (d, i) => Math.floor(i / cols) * blockSize)
            .attr("width", blockSize)
            .attr("height", blockSize)
            .attr("fill", d => colorScale(d.value))
            .attr("tabindex", 0)
            .attr("role", "button")
            .attr("aria-label", d => `${getBookDisplayName(bookId)} 第 ${d.block + 1} 个文本块，${getMetricLabel(currentMetric)} ${formatMetricValue(d.value)}`)
            .on("mouseover", function(event, d) {
                d3.select(this).style("stroke", "#b5472f").style("stroke-width", "2px");
                showTooltip(event, d, bookId);
            })
            .on("mouseout", function() {
                d3.select(this).style("stroke", "#e4d9c3").style("stroke-width", "1px");
                hideTooltip();
            })
            .on("click", function(event, d) { showDetail(d, bookId); })
            .on("keydown", function(event, d) {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    showDetail(d, bookId);
                }
            });

        g.append("text")
            .attr("x", (cols * blockSize) / 2)
            .attr("y", -20)
            .attr("text-anchor", "middle")
            .style("font-size", "14px")
            .style("font-weight", "bold")
            .style("fill", "#6f6557")
            .text(truncateText(getBookDisplayName(bookId), 18));
    });

    svg.append("text")
        .attr("x", containerWidth / 2)
        .attr("y", 30)
        .attr("text-anchor", "middle")
        .style("font-size", "18px")
        .style("font-weight", "bold")
        .style("fill", "#2f2a23")
        .text(`${getMetricLabel(currentMetric)} - 指纹对比 (统一色标: ${globalMin.toFixed(1)} ~ ${globalMax.toFixed(1)})`);

    // 图例：低（黛蓝）↔ 高（赤），并标注当前指标的具体含义
    const [lowLabel, highLabel] = getHeatmapLegend(currentMetric);
    const legendW = 220, legendH = 12;
    const legendX = containerWidth / 2 - legendW / 2;
    const legendY = totalHeight - 26;

    const legendGrad = svg.append("defs").append("linearGradient")
        .attr("id", "heatmapLegendGrad")
        .attr("x1", "0%").attr("x2", "100%");
    legendGrad.append("stop").attr("offset", "0%").attr("stop-color", "#2c4a6e");
    legendGrad.append("stop").attr("offset", "50%").attr("stop-color", "#f2e7cd");
    legendGrad.append("stop").attr("offset", "100%").attr("stop-color", "#a0221a");

    svg.append("rect")
        .attr("x", legendX).attr("y", legendY)
        .attr("width", legendW).attr("height", legendH)
        .attr("rx", 3)
        .attr("fill", "url(#heatmapLegendGrad)")
        .attr("stroke", "#e0d1b0")
        .attr("stroke-width", 1);

    svg.append("text")
        .attr("x", legendX - 10).attr("y", legendY + legendH / 2 + 4)
        .attr("text-anchor", "end")
        .style("font-size", "12px")
        .style("fill", "#2c4a6e")
        .style("font-weight", "bold")
        .text(`低 · ${lowLabel}`);

    svg.append("text")
        .attr("x", legendX + legendW + 10).attr("y", legendY + legendH / 2 + 4)
        .attr("text-anchor", "start")
        .style("font-size", "12px")
        .style("fill", "#a0221a")
        .style("font-weight", "bold")
        .text(`高 · ${highLabel}`);
}

// 工具函数
function smoothData(data, windowSize) {
    if (windowSize <= 1 || !data || data.length === 0) return data;
    
    return data.map((d, i, arr) => {
        const start = Math.max(0, i - Math.floor(windowSize / 2));
        const end = Math.min(arr.length, i + Math.floor(windowSize / 2) + 1);
        const windowData = arr.slice(start, end);
        const avg = windowData.reduce((sum, item) => sum + item.value, 0) / windowData.length;
        
        return {
            ...d,
            value: avg
        };
    });
}

function showTooltip(event, data, bookName) {
    const tooltip = d3.select("body").append("div")
        .attr("class", "tooltip")
        .style("opacity", 0)
        .style("left", (event.pageX + 10) + "px")
        .style("top", (event.pageY - 10) + "px");

    const keywords = Array.isArray(data.keywords) ? data.keywords.map(escapeHtml).join(', ') : '';
    tooltip.html(`
        <div style="margin-bottom: 5px;">
            <strong>${escapeHtml(getBookDisplayName(bookName))}</strong>
        </div>
        <div style="margin-bottom: 3px;">
            <strong>文本块:</strong> ${Number(data.block) + 1}
        </div>
        <div style="margin-bottom: 3px;">
            <strong>${escapeHtml(getMetricLabel(currentMetric))}:</strong> ${escapeHtml(data.value)}
        </div>
        ${keywords ? `<div style="margin-top: 5px;"><strong>关键词:</strong> ${keywords}</div>` : ''}
    `);

    tooltip.transition()
        .duration(200)
        .style("opacity", 1);
}

function hideTooltip() {
    d3.selectAll(".tooltip")
        .transition()
        .duration(200)
        .style("opacity", 0)
        .remove();
}

function showDetail(data, bookName) {
    const detailPanel = document.getElementById('detailPanel');
    if (!detailPanel) return;

    const displayName = getBookDisplayName(bookName);
    const keywordsHtml = Array.isArray(data.keywords) && data.keywords.length > 0
        ? data.keywords.map(keyword => `<span class="keyword-tag">${escapeHtml(keyword)}</span>`).join('')
        : '';
    const previewHtml = data.preview ? `
            <div>
                <h4>📄 原文片段</h4>
                <p style="margin-top: 10px; color: #98907f; font-style: italic;">
                    "${escapeHtml(data.preview)}"
                </p>
            </div>` : '';

    detailPanel.innerHTML = `
        <h3>▤ 数据详情</h3>
        <p>当前选择：${escapeHtml(displayName)} - ${escapeHtml(getMetricLabel(currentMetric))}</p>
        <div class="detail-card">
            <h3>📖 ${escapeHtml(displayName)}</h3>
            <p><strong>文本块编号:</strong> #${Number(data.block) + 1}</p>
            <div class="value">${escapeHtml(formatMetricValue(data.value, 4))}</div>
            <p><strong>${escapeHtml(getMetricLabel(currentMetric))}</strong></p>

            ${keywordsHtml ? `
            <div style="margin: 15px 0;">
                <h4>※ 关键词</h4>
                <div class="keywords">${keywordsHtml}</div>
            </div>` : ''}

            ${previewHtml}
        </div>
    `;
}

function getMetricLabel(metric) {
    const labels = {
        sentenceLength: '平均句长',
        simpsonIndex: '用词重复度',
        hapaxLegomena: 'Honoré 词汇丰富度 R',
        functionWords: '风格走向'
    };
    return labels[metric] || metric;
}

// 当前指标的大白话说明（面向非技术用户）
function updateMetricHint() {
    const el = document.getElementById('metric-hint');
    if (!el) return;
    const hints = {
        sentenceLength: '平均句长：每句话平均多少个词。数值越大句子越长、越书面；越小越短促、越口语化。',
        simpsonIndex: '用词重复度：衡量词汇有多「重复」。数值越高，同一批词反复出现（词汇单调）；越低，用词越多样。',
        hapaxLegomena: 'Honoré 词汇丰富度 R：综合词元总数、不同词型数和只出现一次的词型数。通常不是 0–1 比例；数值越高，词汇使用越丰富。',
        functionWords: '风格走向：用「的、和、是」这类高频小词的用法差异，把文本投成一个风格坐标。位置用于探索，不直接代表严格的跨书相似度。'
    };
    el.innerHTML = `<span class="metric-hint-label">当前指标</span>${escapeHtml(hints[currentMetric] || '')}`;
}

function getBookSafeId(name) {
    const text = String(name ?? 'book');
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    const normalized = text.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'book';
    return `${normalized}_${Math.abs(hash)}`;
}

// 内置名著的中文名映射（面向中文读者），未知书名原样返回
function getBookDisplayName(name) {
    const map = {
        'The Adventures of Tom Sawyer': '汤姆·索亚历险记',
        'The Adventures of Huckleberry Finn': '哈克贝利·费恩历险记',
        'The Call of the Wild': '野性的呼唤',
        'The call of the wild': '野性的呼唤',
        'White Fang': '白牙'
    };
    return map[name] || name;
}

// 指纹热力图图例：低值（黛蓝）↔ 高值（赤）在每个指标下的具体含义
function getHeatmapLegend(metric) {
    const legend = {
        sentenceLength: ['短句', '长句'],
        simpsonIndex: ['用词多样', '用词重复'],
        hapaxLegomena: ['词汇较常规', '词汇更丰富'],
        functionWords: ['投影一端', '投影另一端']
    };
    return legend[metric] || ['低值', '高值'];
}

function toggleMetric() {
    const metrics = ['sentenceLength', 'simpsonIndex', 'hapaxLegomena', 'functionWords'];
    const current = document.getElementById('metricSelect').value;
    const currentIndex = metrics.indexOf(current);
    const nextIndex = (currentIndex + 1) % metrics.length;
    
    document.getElementById('metricSelect').value = metrics[nextIndex];
    currentMetric = metrics[nextIndex];
    
    if (realData) {
        refreshAllActiveCharts();
    }
}

function exportChart() {
    const svg = document.getElementById('main-chart');
    if (!svg) {
        showError("找不到图表元素");
        return;
    }

    const serializer = new XMLSerializer();
    let source = serializer.serializeToString(svg);

    if(!source.match(/^<svg[^>]+xmlns="http\:\/\/www\.w3\.org\/2000\/svg"/)){
        source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    }

    const styleString = `
        <style>
            text { font-family: 'Microsoft YaHei', sans-serif; fill: #2f2a23; }
            .heatmap-rect { stroke: #e4d9c3; stroke-width: 1px; }
            .axis path, .axis line { fill: none; stroke: #98907f; shape-rendering: crispEdges; }
        </style>`;
    source = source.replace('</svg>', styleString + '</svg>');

    const imageSrc = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source);

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const img = new Image();

    const svgRect = svg.getBoundingClientRect();
    const scaleFactor = 2; 
    canvas.width = svgRect.width * scaleFactor;
    canvas.height = svgRect.height * scaleFactor;

    img.onload = function() {
        context.fillStyle = '#f2e7cd';
        context.fillRect(0, 0, canvas.width, canvas.height);
        
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        
        const link = document.createElement('a');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const bookName = Array.from(selectedBooks)[0] ? Array.from(selectedBooks)[0].replace(/\s+/g, '_') : 'Comparison';
        
        link.download = `文印_${bookName}_${chartType}_${timestamp}.png`;
        link.href = canvas.toDataURL('image/png');
        
        document.body.appendChild(link); 
        link.click();
        document.body.removeChild(link);
    };

    img.onerror = function(e) {
        console.error("图像导出失败:", e);
        showError("图像生成失败，请查看控制台详情。");
    };

    img.src = imageSrc;
}

function exportSummary() {
    if (!realData || selectedBooks.size === 0) {
        showError('当前没有可导出的分析数据。请先选择书籍或上传文本。');
        return;
    }

    const books = Array.from(selectedBooks).filter(book => getMetricValues(book, currentMetric).length > 0);
    if (books.length === 0) {
        showError('当前选择的书籍没有可导出的指标数据，请切换指标或重新生成数据。');
        return;
    }

    const metricLabel = getMetricLabel(currentMetric);
    const metricHint = {
        sentenceLength: '每句话平均词数。',
        simpsonIndex: '数值越高表示词汇重复度越高。',
        hapaxLegomena: 'Honoré 词汇丰富度 R；综合词元总数、不同词型数和只出现一次的词型数，通常不是比例。',
        functionWords: '功能词 PCA 的探索性投影，位置不直接等于严格的跨书相似度。'
    }[currentMetric] || '';
    const lines = [
        '# 文印·文学指纹分析摘要',
        '',
        `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
        `- 当前视图：${currentTab === 'view-main' ? (chartType === 'line' ? '基础趋势分析 · 折线趋势图' : '基础趋势分析 · 指纹热力图') : currentTab === 'view-galaxy' ? '风格星系' : '全书对比'}`,
        `- 分析指标：${metricLabel}`,
        `- 指标说明：${metricHint}`,
        `- 选择书籍：${books.map(getBookDisplayName).join('、')}`,
        ''
    ];

    books.forEach(book => {
        const values = getMetricValues(book, currentMetric);
        const mean = d3.mean(values, d => d.value);
        const peak = values.reduce((best, current) => current.value > best.value ? current : best, values[0]);
        lines.push(`## ${getBookDisplayName(book)}`);
        lines.push(`- 文本块数量：${values.length}`);
        lines.push(`- 平均值：${formatMetricValue(mean)}`);
        lines.push(`- 最高片段：第 ${Number(peak.block) + 1} 块，数值 ${formatMetricValue(peak.value)}`);
        if (Array.isArray(peak.keywords) && peak.keywords.length > 0) {
            lines.push(`- 最高片段关键词：${peak.keywords.join('、')}`);
        }
        if (peak.preview) {
            lines.push(`- 原文片段：${String(peak.preview).replace(/\r?\n/g, ' ').trim().substring(0, 240)}`);
        }
        lines.push('');
    });

    lines.push('> 说明：本摘要用于记录当前页面选择。图表中的指标和 PCA 坐标应结合文本块、数据范围与研究问题解读，不应单独作为文学价值判断。');

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const link = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    link.download = `文印_分析摘要_${timestamp}.md`;
    link.href = URL.createObjectURL(blob);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
}

function showLoading(message) {
    const detailPanel = document.getElementById('detailPanel');
    if (!detailPanel) return;
    detailPanel.innerHTML = `
        <div class="state-card loading">
            <h3>◌ ${escapeHtml(message)}</h3>
            <p>正在从当前分析服务获取数据。首次运行需生成示例数据，约 1–2 分钟。</p>
            <div class="state-spinner" aria-hidden="true"></div>
        </div>
    `;
}

function showSuccess(message) {
    const detailPanel = document.getElementById('detailPanel');
    if (!detailPanel) return;
    detailPanel.innerHTML = `
        <div class="detail-card state-card success">
            <h3>${escapeHtml(message)}</h3>
            <p>现在可以点击图表中的数据点查看详细信息。</p>
        </div>
    `;
}

function showError(message) {
    const detailPanel = document.getElementById('detailPanel');
    if (!detailPanel) return;
    detailPanel.innerHTML = `
        <div class="detail-card state-card error">
            <h3>错误</h3>
            <p>${escapeHtml(message)}</p>
        </div>
    `;
}

function showNoDataMessage(message = '请在上方选择一本已有数据的书，或上传文本进行分析。') {
    const detailPanel = document.getElementById('detailPanel');
    if (!detailPanel) return;
    detailPanel.innerHTML = `
        <div class="detail-card state-card empty">
            <h3>暂无数据</h3>
            <p>${escapeHtml(message)}</p>
        </div>
    `;
}

// ==========================================
// ✧ 风格星系 (Style Galaxy)
// ==========================================

let galaxySimulation = null;
let lastGalaxyTrigger = null;

function initStyleGalaxy() {
    // 检查是否可见
    if (currentTab !== 'view-galaxy') return;

    const books = Array.from(selectedBooks);
    if (books.length === 0) {
        const loadingEl = document.getElementById('galaxy-loading');
        if (loadingEl) {
            loadingEl.style.display = 'block';
            loadingEl.textContent = "请先在上方选择书籍";
        }
        return;
    }

    const container = document.getElementById('galaxy-container');
    // 重要：如果容器不可见（clientWidth=0），则中止，防止错误
    if (!container || container.clientWidth === 0) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    d3.select("#galaxy-container").selectAll("svg").remove();
    const loadingEl = document.getElementById('galaxy-loading');
    if (loadingEl) loadingEl.style.display = 'none';

    const svg = d3.select("#galaxy-container").append("svg")
        .attr("width", width)
        .attr("height", height)
        .style("background", "radial-gradient(ellipse at center, #f8efda 0%, #f2e7cd 100%)");

    const defs = svg.append("defs");

    const filter = defs.append("filter").attr("id", "glow");
    filter.append("feGaussianBlur")
        .attr("stdDeviation", "2.5")
        .attr("result", "coloredBlur");
    const feMerge = filter.append("feMerge");
    feMerge.append("feMergeNode").attr("in", "coloredBlur");
    feMerge.append("feMergeNode").attr("in", "SourceGraphic");

    const colorScale = d3.scaleOrdinal()
        .domain(books)
        .range(['#b5472f', '#4f7a8c', '#6b8f5a', '#a67c3d', '#5a6b8c', '#a2546b', '#8c6f4a', '#5f7d72']);

    // 颜色图例：让用户知道每种颜色对应哪本书
    const legendEl = document.getElementById('galaxy-legend');
    if (legendEl) {
        legendEl.innerHTML = '';
        books.forEach(book => {
            const item = document.createElement('span');
            item.className = 'galaxy-legend-item';
            const swatch = document.createElement('span');
            swatch.className = 'galaxy-legend-swatch';
            swatch.style.background = colorScale(book);
            item.appendChild(swatch);
            item.appendChild(document.createTextNode(getBookDisplayName(book)));
            legendEl.appendChild(item);
        });
    }

    books.forEach((book) => {
        const baseColor = d3.color(colorScale(book));
        const highlight = baseColor.brighter(1.5);
        const shadow = baseColor.darker(1.2);

        const gradId = "grad-" + getBookSafeId(book);

        const gradient = defs.append("radialGradient")
            .attr("id", gradId)
            .attr("cx", "30%")
            .attr("cy", "30%")
            .attr("r", "70%");

        gradient.append("stop").attr("offset", "0%").attr("stop-color", highlight.formatHex()).attr("stop-opacity", 1);
        gradient.append("stop").attr("offset", "50%").attr("stop-color", baseColor.formatHex()).attr("stop-opacity", 1);
        gradient.append("stop").attr("offset", "100%").attr("stop-color", shadow.formatHex()).attr("stop-opacity", 1);
    });

    let allNodes = [];

    books.forEach((bookName, bookIndex) => {
        const positionData = getMetricValues(bookName, 'functionWords');
        const displayData = getMetricValues(bookName, currentMetric);

        if (positionData.length && displayData.length) {
            positionData.forEach((d, i) => {
                const metricItem = displayData[i];
                if (!metricItem || !isFiniteNumber(d.value) || !isFiniteNumber(metricItem.value)) return;
                const pcaY = isFiniteNumber(d.value_y) ? d.value_y : getDeterministicFallbackY(bookIndex, Number(d.block) || i);

                allNodes.push({
                    id: `${bookName}_${d.block}`,
                    book: bookName,
                    blockIndex: d.block,
                    pcaX: d.value,
                    pcaY,
                    realValue: metricItem.value,
                    preview: metricItem.preview,
                    extendedPreview: d.extended_preview || metricItem.preview,
                    keywords: metricItem.keywords
                });
            });
        }
    });

    if (allNodes.length === 0) {
        if (loadingEl) {
            loadingEl.style.display = 'block';
            loadingEl.textContent = "所选书籍暂无可用的功能词 PCA 数据。请重新生成数据或换一本书。";
        }
        return;
    }

    const metricExtent = normalizeExtent(d3.extent(allNodes, d => d.realValue));
    const radiusScale = d3.scaleSqrt()
        .domain(metricExtent)
        .range([4, 18]);

    const xExtent = normalizeExtent(d3.extent(allNodes, d => d.pcaX));
    const yExtent = normalizeExtent(d3.extent(allNodes, d => d.pcaY));
    const padding = 60;
    const xScale = d3.scaleLinear().domain(xExtent).range([padding, width - padding]);
    const yScale = d3.scaleLinear().domain(yExtent).range([padding, height - padding]);

    allNodes.forEach(d => {
        d.r = radiusScale(d.realValue);
        d.x = xScale(d.pcaX);
        d.y = yScale(d.pcaY);
    });

    const g = svg.append("g");
    svg.call(d3.zoom()
        .scaleExtent([0.5, 5]) 
        .on("zoom", (event) => {
            g.attr("transform", event.transform);
        }));

    if (galaxySimulation) galaxySimulation.stop();

    galaxySimulation = d3.forceSimulation(allNodes)
        .force("x", d3.forceX(d => xScale(d.pcaX)).strength(0.8))
        .force("y", d3.forceY(d => yScale(d.pcaY)).strength(0.8))
        .force("collide", d3.forceCollide(d => d.r + 1).strength(1))
        .force("charge", d3.forceManyBody().strength(-15))
        .alphaTarget(0)
        .on("tick", ticked);

    const circles = g.selectAll("circle")
        .data(allNodes)
        .enter().append("circle")
        .attr("r", d => d.r)
        .attr("fill", d => `url(#grad-${getBookSafeId(d.book)})`)
        .attr("stroke", d => d3.color(colorScale(d.book)).darker(0.5))
        .attr("stroke-width", 0.5)
        .attr("stroke-opacity", 0.8)
        .attr("tabindex", 0)
        .attr("role", "button")
        .attr("aria-label", d => `${getBookDisplayName(d.book)} 第 ${d.blockIndex + 1} 个文本块，${getMetricLabel(currentMetric)} ${formatMetricValue(d.realValue)}`)
        .style("cursor", "pointer")
        .call(d3.drag()
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended));

    circles.on("mouseover", function(event, d) {
        d3.select(this)
            .transition().duration(100)
            .attr("r", d.r * 1.5)
            .style("filter", "url(#glow)")
            .attr("stroke", "#2f2a23")
            .attr("stroke-width", 2);
        
        const allCircles = g.selectAll("circle");
        const allNodeData = allCircles.data();
        const neighbors = findNeighbors(d, allNodeData, 120); 

        allCircles.filter(node => neighbors.includes(node))
            .transition().duration(100)
            .attr("stroke", "#b5472f")
            .attr("stroke-width", 1.5)
            .attr("stroke-opacity", 1);

        const analysis = analyzeCluster(neighbors);
        const label = window.getMetricLabel ? getMetricLabel(currentMetric) : currentMetric;
        updateHUD(analysis, label);

        showTooltip(event, {
            block: d.blockIndex,
            value: typeof d.realValue === 'number' ? d.realValue.toFixed(4) : d.realValue,
            keywords: d.keywords,
            preview: d.preview 
        }, d.book);
    })
    .on("mouseout", function(event, d) {
        d3.select(this)
            .transition().duration(200)
            .attr("r", d.r)
            .style("filter", null)
            .attr("stroke", d3.color(colorScale(d.book)).darker(0.5))
            .attr("stroke-width", 0.5);

        g.selectAll("circle")
             .transition().duration(200)
             .attr("stroke", node => d3.color(colorScale(node.book)).darker(0.5))
             .attr("stroke-width", 0.5)
             .attr("stroke-opacity", 0.8);
        
        const hud = document.getElementById('galaxy-hud');
        if(hud) {
            hud.querySelector('.hud-title').innerText = "◎ 悬停查看区域风格";
            hud.querySelector('.hud-content').innerHTML = '<p style="color:#98907f; font-size:12px;">将鼠标移到任意圆点上，查看这一片区域的风格特征。</p>';
        }
        
        hideTooltip();
    })
    .on("click", (event, d) => {
        event.stopPropagation();
        lastGalaxyTrigger = event.currentTarget;
        openGalaxyModal(d);
    })
    .on("keydown", (event, d) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            lastGalaxyTrigger = event.currentTarget;
            openGalaxyModal(d);
        }
    });

    function ticked() {
        circles
            .attr("cx", d => d.x)
            .attr("cy", d => d.y);
    }

    function dragstarted(event, d) {
        if (!event.active) galaxySimulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
        d3.select(this).style("cursor", "grabbing");
    }

    function dragged(event, d) {
        d.fx = event.x;
        d.fy = event.y;
    }

    function dragended(event, d) {
        if (!event.active) galaxySimulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
        d3.select(this).style("cursor", "pointer");
    }
}

// ==========================================
// 📜 悬浮页控制函数
// ==========================================

function openGalaxyModal(d) {
    const modal = document.getElementById('galaxy-modal');
    if (!modal) return;

    const titleEl = document.getElementById('modal-book-title');
    if (titleEl) titleEl.textContent = getBookDisplayName(d.book);

    const blockEl = document.getElementById('modal-block-id');
    if (blockEl) blockEl.textContent = `文本块 #${Number(d.blockIndex) + 1}`;

    const valDisplay = isFiniteNumber(d.realValue) ? d.realValue.toFixed(4) : '暂无';
    const metricEl = document.getElementById('modal-metric-val');
    if (metricEl) metricEl.textContent = `${getMetricLabel(currentMetric)}: ${valDisplay}`;

    const keywordContainer = document.getElementById('modal-keywords');
    if (keywordContainer) {
        keywordContainer.replaceChildren();
        if (Array.isArray(d.keywords) && d.keywords.length > 0) {
            d.keywords.forEach(kw => {
                const span = document.createElement('span');
                span.textContent = kw;
                keywordContainer.appendChild(span);
            });
        } else {
            const empty = document.createElement('span');
            empty.style.color = '#98907f';
            empty.textContent = '无关键词';
            keywordContainer.appendChild(empty);
        }
    }

    const textContainer = document.getElementById('modal-long-text');
    if (textContainer) textContainer.textContent = d.extendedPreview || d.preview || "暂无详细文本内容...";

    modal.setAttribute('aria-hidden', 'false');
    modal.style.display = 'flex';
    setTimeout(() => {
        modal.classList.add('show');
        const closeButton = modal.querySelector('.galaxy-modal-close');
        if (closeButton) closeButton.focus();
    }, 10);
}

function closeGalaxyModal() {
    const modal = document.getElementById('galaxy-modal');
    if (!modal) return;

    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
        modal.style.display = 'none';
        if (lastGalaxyTrigger && typeof lastGalaxyTrigger.focus === 'function') {
            lastGalaxyTrigger.focus();
        }
        lastGalaxyTrigger = null;
    }, 300);
}

document.addEventListener('DOMContentLoaded', function() {
    const modal = document.getElementById('galaxy-modal');
    if (modal) {
        modal.addEventListener('click', function(e) {
            if (e.target === this) closeGalaxyModal();
        });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && modal.getAttribute('aria-hidden') === 'false') {
                closeGalaxyModal();
            }
        });
    }
});

window.restartGalaxy = function() {
    initStyleGalaxy();
};

window.selectBook = selectBook;

// ==========================================
// ◎ 星系探针分析逻辑
// ==========================================

function findNeighbors(centerNode, allNodes, radius = 80) {
    return allNodes.filter(node => {
        const dx = node.x - centerNode.x;
        const dy = node.y - centerNode.y;
        return Math.sqrt(dx*dx + dy*dy) < radius;
    });
}

function analyzeCluster(neighbors) {
    if (neighbors.length === 0) return null;

    const bookCounts = {};
    neighbors.forEach(n => {
        bookCounts[n.book] = (bookCounts[n.book] || 0) + 1;
    });
    const dominantBook = Object.keys(bookCounts).reduce((a, b) => bookCounts[a] > bookCounts[b] ? a : b);
    const dominanceRate = (bookCounts[dominantBook] / neighbors.length) * 100;

    const totalMetric = neighbors.reduce((sum, n) => sum + (n.realValue || 0), 0);
    const avgMetric = totalMetric / neighbors.length;

    const keywordMap = {};
    neighbors.forEach(n => {
        if(n.keywords) {
            n.keywords.forEach(kw => {
                keywordMap[kw] = (keywordMap[kw] || 0) + 1;
            });
        }
    });
    const topKeywords = Object.keys(keywordMap)
        .sort((a, b) => keywordMap[b] - keywordMap[a])
        .slice(0, 5);

    return {
        count: neighbors.length,
        dominantBook: dominantBook,
        dominanceRate: dominanceRate,
        avgMetric: avgMetric,
        topKeywords: topKeywords
    };
}

function updateHUD(analysisData, metricLabel) {
    const hud = document.getElementById('galaxy-hud');
    const content = hud.querySelector('.hud-content');
    const title = hud.querySelector('.hud-title');

    if (!analysisData) {
        title.innerText = "◎ 正在分析...";
        content.innerHTML = `<p style="color:#98907f; font-size:12px;">正在分析这片区域的风格...</p>`;
        return;
    }

    title.innerHTML = `◎ 选中区域（${analysisData.count} 个片段）`;

    let html = `
        <div class="hud-row">
            <span class="hud-label">主要来自:</span>
            <span class="hud-value" style="color:#2f2a23">${analysisData.dominantBook.substring(0, 15)}...</span>
        </div>
        <div class="hud-bar-bg" title="这本书占比 ${analysisData.dominanceRate.toFixed(0)}%">
            <div class="hud-bar-fill" style="width: ${analysisData.dominanceRate}%;"></div>
        </div>
        <div class="hud-row" style="margin-top:8px;">
            <span class="hud-label">区域平均${metricLabel}:</span>
            <span class="hud-value" style="color:#b5472f">${analysisData.avgMetric.toFixed(2)}</span>
        </div>
        <div class="hud-row" style="margin-top:8px;">
            <span class="hud-label">共同关键词:</span>
        </div>
        <div class="hud-tags">
            ${analysisData.topKeywords.map(k => `<span class="hud-tag">${k}</span>`).join('')}
        </div>
        <div style="margin-top:10px; padding-top:5px; border-top:1px dashed rgba(46, 42, 36, 0.12); font-size:10px; color:#98907f;">
            * 这些片段因写作风格相近而聚集在一起。
        </div>
    `;

    content.innerHTML = html;
}

// ==========================================
// ⋮ 黑客帝国文本雨 (Matrix Keyword Rain)
// ==========================================

let matrixInterval = null;
let isMatrixOn = false;

function initMatrixRain() {
    const canvas = document.getElementById('matrix-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // 收集书籍关键词（读起来更像「文字」，而非乱码）
    let words = [];
    if (typeof realData !== 'undefined' && realData) {
        Object.values(realData).forEach(bookData => {
            const metricData = bookData[currentMetric] || Object.values(bookData)[0];
            if (Array.isArray(metricData)) {
                metricData.forEach(block => {
                    if (block.keywords && Array.isArray(block.keywords)) {
                        words.push(...block.keywords.filter(w => w.length < 12));
                    }
                });
            }
        });
    }
    if (words.length < 50) {
        words = [
            'Literature', 'Style', 'Twain', 'London', 'Novel', 'Plot',
            'Character', 'Emotion', 'Fingerprint', 'Text', 'Stream', 'Galaxy'
        ];
    }
    words = [...new Set(words)];

    const fontSize = 15;
    const fontFamily = 'Consolas, "Microsoft YaHei", monospace';
    const columns = Math.floor(canvas.width / fontSize);

    // 暖墨 · 羊皮纸 · 金，贴合「墨」主题（低饱和、不刺眼）
    const PALETTE = ['#c9bda3', '#b3a58a', '#98907f', '#a67c3d', '#b5472f'];

    // 每列一枚「雨滴」：颜色、文字、速度、透明度在下落全程保持不变，避免闪烁
    const drops = [];
    for (let i = 0; i < columns; i++) {
        drops[i] = {
            y: Math.random() * -60,
            speed: 0.25 + Math.random() * 0.6,
            word: words[Math.floor(Math.random() * words.length)],
            color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
            opacity: 0.12 + Math.random() * 0.45
        };
    }

    function draw() {
        // 轻柔淡出拖尾（淡入暖墨背景）
        ctx.fillStyle = 'rgba(242, 231, 205, 0.08)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.textAlign = 'center';
        ctx.font = `${fontSize}px ${fontFamily}`;

        for (let i = 0; i < drops.length; i++) {
            const d = drops[i];
            const x = i * fontSize + fontSize / 2;
            const y = d.y * fontSize;

            ctx.globalAlpha = d.opacity;
            ctx.fillStyle = d.color;
            ctx.fillText(d.word, x, y);
            ctx.globalAlpha = 1;

            d.y += d.speed;

            if (y > canvas.height + 40) {
                d.y = Math.random() * -15;
                d.word = words[Math.floor(Math.random() * words.length)];
                d.color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
            }
        }
    }

    if (matrixInterval) clearInterval(matrixInterval);
    matrixInterval = setInterval(draw, 50);

    window.onresize = () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    };
}

function toggleMatrixRain() {
    const canvas = document.getElementById('matrix-canvas');
    const btn = document.getElementById('btn-matrix');
    
    isMatrixOn = !isMatrixOn;

    if (isMatrixOn) {
        initMatrixRain(); 
        canvas.classList.add('active'); 
        btn.classList.add('active');
        btn.innerHTML = "■ 停止文本雨";
    } else {
        canvas.classList.remove('active'); 
        btn.classList.remove('active');
        btn.innerHTML = "⋮ 激活文本雨";
        
        setTimeout(() => {
            if (matrixInterval) clearInterval(matrixInterval);
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }, 1000);
    }
}