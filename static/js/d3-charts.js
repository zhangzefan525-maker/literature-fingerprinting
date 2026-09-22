// static/js/d3-charts.js

// API配置（同源部署：本地与 Render 均使用空路径，自动指向当前站点）
const API_BASE_URL = '';
const API_ENDPOINTS = {
    fingerprintData: `${API_BASE_URL}/api/fingerprint-data`,
    books: `${API_BASE_URL}/api/books`
};

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function isLocalHost() {
    const hostname = (window.location.hostname || '').toLowerCase();
    return LOCAL_HOSTNAMES.has(hostname);
}

const DEFAULT_UPLOAD_STATUS = '支持上传英文纯文本小说（.txt，建议 1 万个英文单词以上）。分析后会出现在上方的书名列表里，和内置名著放在一起对比。';

// 全局变量
let realData = null;
let currentMetric = 'sentenceLength';
let selectedBooks = new Set();
let smoothness = 3;
let chartType = 'heatmap';
let currentTab = 'view-main'; // 记录当前标签页
let builtinBookNames = [];    // 服务器上常驻的示例书（用作解读参照基准，不含用户自己上传的）

const METRIC_KEYS = ['sentenceLength', 'simpsonIndex', 'hapaxLegomena', 'functionWords'];
const VIEW_IDS = ['view-main', 'view-galaxy', 'view-dashboard'];
const DEFAULT_SMOOTHNESS = 3;

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    applyUrlState(readUrlState()); // 先按链接里的状态设置视图，再加载数据
    initEventListeners();
    initTabKeyboard();
    applyQuickStartVisibility();
    updateChartTypeUI();
    setUploadStatus(`${DEFAULT_UPLOAD_STATUS} ${getUploadPrivacyNotice()}`);
    syncSaveToggleDefault();
    updateMetricHint();
    loadBooksList();

    // 系统开了「减少动态效果」就不自动启动文本雨（按钮仍然可以手动打开）
    setMatrixRain(!prefersReducedMotion());
});

// ==========================================
// 🔗 视图状态放进网址（能分享、能复现）
// ==========================================
// 只写「看得见的选择」：指标、选中的书、标签页、图表类型、平滑度、框选范围。
// 用 replaceState 而不是 pushState——不往浏览器历史里塞记录，返回键行为不变。
let pendingUrlBooks = null;
let pendingUrlBrush = null;

function readUrlState() {
    let params;
    try {
        params = new URLSearchParams(window.location.search);
    } catch (e) {
        return null; // 极老的浏览器没有 URLSearchParams，当作没有链接状态
    }

    const state = {};
    const metric = params.get('metric');
    if (metric && METRIC_KEYS.includes(metric)) state.metric = metric;
    const chart = params.get('chart');
    if (chart === 'line' || chart === 'heatmap') state.chartType = chart;
    const smooth = Number(params.get('smooth'));
    if (isFiniteNumber(smooth) && smooth >= 1 && smooth <= 10) state.smoothness = smooth;
    const view = params.get('view');
    if (view && VIEW_IDS.includes(view)) state.tab = view;
    const books = params.get('books');
    if (books) {
        const list = books.split('|').map(item => item.trim()).filter(Boolean);
        if (list.length > 0) state.books = list;
    }
    const brush = params.get('brush');
    if (brush && /^\d+(\.\d+)?-\d+(\.\d+)?$/.test(brush)) state.brush = brush.split('-').map(Number);
    return state;
}

function applyUrlState(state) {
    if (!state) return;

    if (state.metric) {
        currentMetric = state.metric;
        const select = document.getElementById('metricSelect');
        if (select) select.value = state.metric;
    }
    if (state.chartType) {
        chartType = state.chartType;
        const select = document.getElementById('chartTypeSelect');
        if (select) select.value = state.chartType;
    }
    if (isFiniteNumber(state.smoothness)) {
        smoothness = state.smoothness;
        const slider = document.getElementById('smoothness');
        if (slider) slider.value = String(state.smoothness);
    }
    // 先记住链接里的选书再切标签：switchTab 会顺手把状态写回网址，
    // 晚一步记就会把 books 参数抹掉
    if (state.books) {
        pendingUrlBooks = state.books;
        selectedBooks = new Set(state.books);
    }
    if (state.brush) pendingUrlBrush = state.brush;

    if (state.tab) window.switchTab(state.tab);

    updateMetricHint();
}

// 把当前视图状态写回网址栏（不产生历史记录）
function syncUrlState() {
    if (!window.history || !window.history.replaceState) return;
    window.history.replaceState(null, '', buildStateUrl());
}

// 当前状态对应的完整链接（复制链接、导出摘要都用它）
function buildStateUrl() {
    const params = new URLSearchParams();
    if (currentMetric !== METRIC_KEYS[0]) params.set('metric', currentMetric);
    if (chartType !== 'heatmap') params.set('chart', chartType);
    if (smoothness !== DEFAULT_SMOOTHNESS) params.set('smooth', String(smoothness));
    if (currentTab !== VIEW_IDS[0]) params.set('view', currentTab);
    const books = Array.from(selectedBooks);
    if (books.length > 0) params.set('books', books.join('|'));

    // advState 定义在页面内的另一段脚本里，取不到就当没有框选
    try {
        const brushRange = (typeof advState !== 'undefined' && advState) ? advState.brushRange : null;
        if (Array.isArray(brushRange) && brushRange.length === 2 && brushRange.every(isFiniteNumber)) {
            params.set('brush', `${brushRange[0].toFixed(4)}-${brushRange[1].toFixed(4)}`);
        }
    } catch (e) { /* 没有框选状态，忽略 */ }

    const query = params.toString();
    return `${window.location.origin}${window.location.pathname}${query ? `?${query}` : ''}`;
}

// 「复制此链接」：把当前视图（指标/选书/标签页/图形/框选）发给同事
function copyShareLink(button) {
    syncUrlState();
    copyTextToClipboard(buildStateUrl(), button, '✓ 链接已复制');
}

// 取走链接里带的框选范围（仪表盘初始化时用，取一次就清掉）
function consumePendingUrlBrush() {
    const range = pendingUrlBrush;
    pendingUrlBrush = null;
    return Array.isArray(range) && range.length === 2 ? range : null;
}

// 「存入我的图书馆」勾选框：本地默认勾选（本机留档安全），远程默认不勾（默认不落盘）
function syncSaveToggleDefault() {
    const cb = document.getElementById('save-upload');
    if (cb) cb.checked = isLocalHost();
}

// 上传是否要写入「我的图书馆」：以勾选框为准；找不到勾选框时本机默认保存、远程不保存
function isUploadSaveWanted() {
    const cb = document.getElementById('save-upload');
    if (cb) return cb.checked;
    return isLocalHost();
}

function getUploadPrivacyNotice() {
    if (isLocalHost()) {
        return '分析只在本机进行，不上传服务器。勾选「存入我的图书馆」后，结果会保存到本机，刷新后仍在；不勾选则本次不保存。';
    }
    return '文件会发到这台网页的服务器做分析。勾选「存入我的图书馆」后，结果会写入服务器（重新部署可能被清空），且当前页面未加密传输，请不要上传敏感或未获授权的文本；不勾选则本次不保存。';
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

// 每个指标的显示精度（唯一来源，别在各处另写 toFixed）。
// 原来的 formatMetricValue(value, digits=2) 已并入 formatMetric：
// 默认 2 位正是「用词重复度」被压成 0.01 的根因，所以不再保留那个容易误用的默认值。
// 依据是 data/processed/all_books.json 里四本内置书的真实取值范围：
//   平均句长    14.2 – 32.4       → 2 位够
//   用词重复度  0.0089 – 0.0155   → 必须 4 位，2 位会把四本书全压成「0.01」，屏幕上看着一模一样
//   独特词丰富度 1725 – 2516（Honoré R）→ 取整
//   风格走向    ±0.07（二维坐标）  → 3 位
const METRIC_DIGITS = {
    sentenceLength: 2,
    simpsonIndex: 4,
    hapaxLegomena: 0,
    functionWords: 3
};

function getMetricDigits(metric = currentMetric) {
    return isFiniteNumber(METRIC_DIGITS[metric]) ? METRIC_DIGITS[metric] : 2;
}

// 显示指标数值统一走这个函数：位数跟着指标走，四个出口（详情面板 / 图注 / 摘要 / 悬停）口径一致
function formatMetric(value, metric = currentMetric) {
    if (!isFiniteNumber(value)) return '暂无';
    const digits = getMetricDigits(metric);
    return digits === 0 ? String(Math.round(value)) : value.toFixed(digits);
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

// ==========================================
// ✧ 风格星系的跨书可比性
// ==========================================
// 只有出自同一个投影模型（mode = "shared"）的书，坐标才落在同一个基底上、才能画进同一张图。
// 老书库（v1）是在各自书上单独拟合的，把它们混画在一起会让人读出并不存在的差异。
function getGalaxyComparability(books) {
    const shared = [];
    const others = [];
    books.forEach((book) => {
        const meta = normalizeBookMeta(book);
        const proj = meta && meta.projection;
        if (proj && proj.mode === 'shared' && proj.axisExtent) shared.push({ book, proj });
        else others.push(book);
    });

    const modelIds = Array.from(new Set(shared.map(item => item.proj.modelId || 'unknown')));
    if (modelIds.length > 1) {
        // 出自不同模型 = 两套基底，同样不能混画
        return {
            plotBooks: [], independentBooks: books.slice(),
            axisExtent: null, axisLabels: [], modelId: null, mixedModel: true
        };
    }

    const first = shared[0] || null;
    return {
        plotBooks: shared.map(item => item.book),
        independentBooks: others,
        axisExtent: first ? first.proj.axisExtent : null,
        axisLabels: first ? (first.proj.axisLabels || []) : [],
        modelId: first ? first.proj.modelId : null,
        mixedModel: false
    };
}

// 坐标系范围：优先用模型给出的固定范围，切换选书时点不会乱跳。
// 若数据的坐标超出该范围（例如上传了一本风格差别很大的书），才扩展范围并如实说明。
function resolveGalaxyExtent(nodes, fixedExtent) {
    const xs = nodes.map(d => d.pcaX).filter(isFiniteNumber);
    const ys = nodes.map(d => d.pcaY).filter(isFiniteNumber);
    const pad = (range) => {
        const span = (range[1] - range[0]) || 1;
        return [range[0] - span * 0.05, range[1] + span * 0.05];
    };

    if (fixedExtent && Array.isArray(fixedExtent.x) && Array.isArray(fixedExtent.y)) {
        const x = pad(fixedExtent.x);
        const y = pad(fixedExtent.y);
        const outX = xs.some(v => v < x[0] || v > x[1]);
        const outY = ys.some(v => v < y[0] || v > y[1]);
        return {
            x: outX ? [Math.min(x[0], d3.min(xs)), Math.max(x[1], d3.max(xs))] : x,
            y: outY ? [Math.min(y[0], d3.min(ys)), Math.max(y[1], d3.max(ys))] : y,
            outOfRange: outX || outY
        };
    }
    return {
        x: normalizeExtent(d3.extent(xs)),
        y: normalizeExtent(d3.extent(ys)),
        outOfRange: false
    };
}

// 把「这批点能不能互相比较」写在图下面，别让用户自己去猜
function renderGalaxyNote(comparability, extent, droppedBlocks) {
    const el = document.getElementById('galaxy-axis-note');
    if (!el) return;
    const lines = [];
    let warn = false;

    if (comparability.plotBooks.length === 0) {
        warn = true;
        lines.push('⚠ 当前选中的书没有共同的坐标基准（多为旧版数据或不同模型生成的坐标），下面按「各书各自计算」的方式摆放：点与点之间的距离不可直接比较。重新上传一次 .txt 即可获得可比坐标。');
    } else {
        (comparability.axisLabels || []).forEach(text => lines.push(text));
        if (comparability.independentBooks.length > 0) {
            warn = true;
            const names = comparability.independentBooks.map(getBookDisplayName).join('、');
            lines.push(`⚠ 《${names}》的坐标是旧版数据、没有共同基准，因此没有画进这张图；重新上传同名 .txt 即可获得可比坐标。`);
        }
        if (comparability.mixedModel) {
            warn = true;
            lines.push('⚠ 选中的书来自不同的坐标模型，无法直接比较，本图未画入。');
        }
        if (extent && extent.outOfRange) {
            warn = true;
            lines.push('⚠ 有片段的坐标超出了内置示例书的范围，图已自动扩展显示。');
        }
        if (droppedBlocks > 0) {
            lines.push(`（有 ${droppedBlocks} 个片段缺少坐标数据，未画入。）`);
        }
        if (lines.length === 0) {
            el.hidden = true;
            el.innerHTML = '';
            return;
        }
    }

    el.hidden = false;
    el.className = 'galaxy-note' + (warn ? ' galaxy-note-warn' : '');
    el.innerHTML = lines
        .map(text => `<span class="galaxy-note-line">${escapeHtml(text)}</span>`)
        .join('');
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

    syncUrlState();
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
        syncUrlState();
    });

    // 平滑度调整
    document.getElementById('smoothness').addEventListener('input', function(e) {
        smoothness = parseInt(e.target.value);
        if (realData) {
            initChart();
        }
        syncUrlState();
    });

    // 导出图像 / 导出摘要 / 复制链接
    document.getElementById('exportBtn').addEventListener('click', exportChart);
    const exportSummaryBtn = document.getElementById('exportSummaryBtn');
    if (exportSummaryBtn) exportSummaryBtn.addEventListener('click', exportSummary);
    const exportSvgBtn = document.getElementById('exportSvgBtn');
    if (exportSvgBtn) exportSvgBtn.addEventListener('click', exportVectorChart);
    const exportDataBtn = document.getElementById('exportDataBtn');
    if (exportDataBtn) exportDataBtn.addEventListener('click', exportTableData);
    const exportCiteBtn = document.getElementById('exportCiteBtn');
    if (exportCiteBtn) exportCiteBtn.addEventListener('click', exportCitation);
    const copyLinkBtn = document.getElementById('copyLinkBtn');
    if (copyLinkBtn) copyLinkBtn.addEventListener('click', () => copyShareLink(copyLinkBtn));

    // 新增：图表类型切换监听
    document.getElementById('chartTypeSelect').addEventListener('change', function(e) {
        chartType = e.target.value;
        updateChartTypeUI();
        if (realData) {
            initChart();
        }
        syncUrlState();
    });

    // 上传自定义文本
    const fileInput = document.getElementById('file-upload');
    if (fileInput) fileInput.addEventListener('change', handleFileUpload);
}

// tablist 键盘操作：← → 切换视图，Home / End 跳到首尾（WAI-ARIA tabs 的惯例）
function initTabKeyboard() {
    const tabs = Array.from(document.querySelectorAll('.tab-btn'));
    if (tabs.length === 0) return;

    tabs.forEach((tab, index) => {
        tab.addEventListener('keydown', (event) => {
            let next = null;
            if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
            else if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
            else if (event.key === 'Home') next = tabs[0];
            else if (event.key === 'End') next = tabs[tabs.length - 1];
            if (!next) return;

            event.preventDefault();
            const viewId = next.getAttribute('aria-controls');
            if (viewId) window.switchTab(viewId);
            next.focus();
        });
    });
}

// 「载入对比示例」：挑出在当前观察角度下差别最大的两本内置书
// （帮第一次来的用户一键看到「对比」长什么样，而不是自己盲选）
function loadComparisonExample() {
    if (!realData) {
        setUploadStatus('数据还在加载中，请稍等一下再试。', 'error');
        return;
    }

    const candidates = (builtinBookNames.length > 0 ? builtinBookNames : Object.keys(realData))
        .filter(name => getMetricValues(name, currentMetric).length > 0);
    if (candidates.length === 0) {
        setUploadStatus('暂时没有可用来做示例的书。', 'error');
        return;
    }

    let picks = [candidates[0]];
    if (candidates.length > 1) {
        const ranked = candidates
            .map(name => ({ name, mean: d3.mean(getMetricValues(name, currentMetric).map(d => d.value)) }))
            .filter(item => isFiniteNumber(item.mean))
            .sort((a, b) => a.mean - b.mean);
        picks = ranked.length > 1 ? [ranked[0].name, ranked[ranked.length - 1].name] : candidates.slice(0, 2);
    }

    selectedBooks = new Set(picks);
    syncBookButtonStates();
    refreshAllActiveCharts();
    syncUrlState();
    setUploadStatus(
        `已选中《${picks.map(getBookDisplayName).join('》《')}》：它们的「${getMetricLabel(currentMetric)}」差别最大，适合先看差异。换「观察角度」可以再挑别的组合。`,
        'success'
    );
}

// 快速开始条：点 ✕ 收起，之后不再自动出现（记在本机浏览器里）
const QUICKSTART_HIDDEN_KEY = 'wenxin.quickstartHidden';

function applyQuickStartVisibility() {
    const el = document.getElementById('quickstart');
    if (!el) return;
    let hidden = false;
    try {
        hidden = window.localStorage.getItem(QUICKSTART_HIDDEN_KEY) === '1';
    } catch (e) {
        hidden = false;
    }
    el.hidden = hidden;
}

window.hideQuickStart = function() {
    const el = document.getElementById('quickstart');
    if (el) el.hidden = true;
    try {
        window.localStorage.setItem(QUICKSTART_HIDDEN_KEY, '1');
    } catch (e) { /* 存不了就这次会话内收起 */ }
};

window.loadComparisonExample = loadComparisonExample;

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
    if (isUploadSaveWanted()) formData.append('save', '1');

    try {
        const resp = await fetch(`${API_BASE_URL}/api/analyze`, { method: 'POST', body: formData });
        const contentType = resp.headers.get('content-type') || '';
        const result = contentType.includes('application/json') ? await resp.json() : null;

        if (!resp.ok || !result || result.status !== 'success') {
            setUploadStatus(getErrorMessage(resp, result), 'error');
            return;
        }

        if (!realData) realData = {};
        realData[result.book] = result.data; // 一律以服务端返回的 result.book 作为键
        selectedBooks.add(result.book);
        // 保存下来的书要记住服务端发的删除令牌，之后删它时才认得出是「保存这本书的浏览器」
        if (result.saved && result.deleteToken) rememberDeleteToken(result.book, result.deleteToken);
        addUploadedBookButton(result.book, { deletable: !!result.saved });
        updateCompareButtonLabel();
        syncUrlState();
        const nBlocks = result.data && result.data.metadata ? result.data.metadata.totalBlocks : 0;
        const savedMsg = result.saved
            ? '已存入「我的图书馆」，刷新后仍在，可点书名旁 ✕ 删除。'
            : '本次未勾选保存，刷新后不会保留。';
        setUploadStatus(`「${getBookDisplayName(result.book)}」分析完成，共划分 ${nBlocks} 个片段。${savedMsg}`, 'success');
        updateMetricHint();
        refreshAllActiveCharts();
    } catch (e) {
        console.error('上传分析失败:', e);
        setUploadStatus('上传失败：无法连接当前分析服务。请确认服务器已启动，或稍后重试。', 'error');
    } finally {
        setUploadBusy(false);
        input.value = ''; // 允许重复上传同一文件
    }
}

// 生成一个「书名 chip」：来自「我的图书馆」的书带 ✕ 删除钮
// （删除钮 stopPropagation，避免误触发选书）
function buildBookGroup(book, { active = false, deletable = false, onClick } = {}) {
    const id = book.id;
    const wrap = document.createElement('span');
    wrap.className = 'book-group';
    wrap.dataset.bookId = id;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'book-btn' + (active ? ' active' : '');
    button.dataset.id = id;
    button.title = book.name || id;
    button.textContent = getBookDisplayName(book.name || id);
    if (typeof onClick === 'function') button.addEventListener('click', onClick);
    wrap.appendChild(button);

    if (deletable || book.source === 'library') {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'book-del';
        del.title = '从「我的图书馆」删除这本书';
        del.setAttribute('aria-label', `删除「${getBookDisplayName(book.name || id)}」`);
        del.textContent = '✕';
        del.addEventListener('click', (event) => {
            event.stopPropagation();
            deleteLibraryBook(id);
        });
        wrap.appendChild(del);
    }
    return wrap;
}

// 将上传的书动态加入选择器，并保持选中态
function addUploadedBookButton(bookName, { deletable = false } = {}) {
    const selector = document.getElementById('bookSelector');
    if (!selector) return;
    const existing = getBookButtonById(bookName);
    if (existing) {
        // 此前是「未保存」瞬时 chip，这次真正落盘后需补上删除钮
        const wrap = existing.closest('.book-group');
        if (wrap && deletable && !wrap.querySelector('.book-del')) {
            wrap.replaceWith(buildBookGroup(
                { id: bookName, name: bookName },
                { active: true, deletable: true, onClick: () => selectBook(bookName) }
            ));
        }
        return;
    }

    selector.appendChild(buildBookGroup(
        { id: bookName, name: bookName },
        { active: true, deletable, onClick: () => selectBook(bookName) }
    ));
}

// 书库删除令牌：保存时服务端发一个，存在本浏览器里，删除时带回去。
// 这样在线上演示环境里，别人无法凭一个书名就删掉你的书（本机访问不需要令牌）。
const DELETE_TOKEN_KEY = 'wenxin.deleteTokens';

function readDeleteTokens() {
    try {
        const raw = window.localStorage.getItem(DELETE_TOKEN_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        return {}; // 隐私模式等场景读不到，按没有令牌处理
    }
}

function writeDeleteTokens(tokens) {
    try {
        window.localStorage.setItem(DELETE_TOKEN_KEY, JSON.stringify(tokens));
    } catch (e) { /* 写不进去就算了：本机访问本来就不需要令牌 */ }
}

function rememberDeleteToken(bookName, token) {
    if (!bookName || !token) return;
    const tokens = readDeleteTokens();
    tokens[bookName] = token;
    writeDeleteTokens(tokens);
}

function forgetDeleteToken(bookName) {
    const tokens = readDeleteTokens();
    if (!(bookName in tokens)) return;
    delete tokens[bookName];
    writeDeleteTokens(tokens);
}

function getDeleteToken(bookName) {
    return readDeleteTokens()[bookName] || '';
}

// 正在删除中的书名。删除是一次网络往返，期间再点 ✕ 会重复发请求、重复弹确认，
// 而且第二次请求多半拿到 404 弹出「删除失败」，看起来像删除没成功。
// 用一个 Set 做闸门：在途时直接忽略后续点击，并把该 chip 的 ✕ 临时禁用做视觉提示。
const _deletingBooks = new Set();

// 从「我的图书馆」删除：确认 → DELETE 接口 → 同步内存/选择/按钮/图表
async function deleteLibraryBook(bookName) {
    if (_deletingBooks.has(bookName)) return;
    if (!window.confirm(`确定从「我的图书馆」删除《${getBookDisplayName(bookName)}》？此操作不可撤销。`)) return;

    _deletingBooks.add(bookName);
    setDeletingBookState(bookName, true);
    setUploadBusy(true);
    try {
        const headers = {};
        const token = getDeleteToken(bookName);
        if (token) headers['X-Delete-Token'] = token;
        const resp = await fetch(`${API_BASE_URL}/api/library/${encodeURIComponent(bookName)}`, { method: 'DELETE', headers });
        const contentType = resp.headers.get('content-type') || '';
        const result = contentType.includes('application/json') ? await resp.json() : null;
        if (!resp.ok) {
            setUploadStatus(getErrorMessage(resp, result), 'error');
            return;
        }

        if (realData) delete realData[bookName];
        selectedBooks.delete(bookName);
        forgetDeleteToken(bookName);
        document.querySelectorAll('.book-group').forEach(group => {
            if (group.dataset.bookId === bookName) group.remove();
        });
        syncUrlState();

        setUploadStatus((result && result.message) || `已从「我的图书馆」删除《${getBookDisplayName(bookName)}》。`, 'success');
        updateMetricHint();

        const remaining = Object.keys(realData || {}).length;
        if (remaining === 0) {
            const selector = document.getElementById('bookSelector');
            if (selector) selector.innerHTML = '<p class="state-card empty">没有已加载的书籍了。请上传文本，或将 .txt 放入 data/raw。</p>';
            showNoDataMessage();
            return;
        }
        if (selectedBooks.size === 0) {
            const firstBtn = document.querySelector('.book-btn');
            if (firstBtn) selectBook(firstBtn.dataset.id);
        } else {
            refreshAllActiveCharts();
        }
    } catch (e) {
        console.error('删除书库书籍失败:', e);
        setUploadStatus('删除失败：无法连接当前分析服务。', 'error');
    } finally {
        _deletingBooks.delete(bookName);
        setDeletingBookState(bookName, false);
        setUploadBusy(false);
    }
}

// 删除在途时把该书的 ✕ 置灰并禁用，避免重复提交
function setDeletingBookState(bookName, deleting) {
    document.querySelectorAll('.book-group').forEach(group => {
        if (group.dataset.bookId !== bookName) return;
        const del = group.querySelector('.book-del');
        if (!del) return;
        del.disabled = deleting;
        del.classList.toggle('deleting', deleting);
        del.setAttribute('aria-busy', deleting ? 'true' : 'false');
    });
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
        selector.appendChild(buildBookGroup(book, {
            onClick: () => selectBook(book.id)
        }));
    });

    // 解读参照只用内置示例书：用户自己上传的书不该拿来当"基准"
    builtinBookNames = books.filter(book => book.source !== 'library').map(book => book.id);

    if (pendingUrlBooks && pendingUrlBooks.length > 0) {
        // 链接里指定了选书：按它还原（不存在的书名会在数据加载后自动剔除）
        pendingUrlBooks = null;
        syncBookButtonStates();
    } else {
        // 默认选中第一本书
        selectBook(books[0].id);
    }
}

function selectBook(bookId) {
    const btn = getBookButtonById(bookId);

    if (selectedBooks.has(bookId)) {
        if (selectedBooks.size > 1) {
            selectedBooks.delete(bookId);
            if (btn) btn.classList.remove('active');
        }
    } else {
        // 如果未选中，则添加
        selectedBooks.add(bookId);
        if (btn) btn.classList.add('active');
    }

    updateCompareButtonLabel();

    // 刷新当前可见的图表
    if (realData) {
        refreshAllActiveCharts();
    }
    syncUrlState();
}

// 对比状态提示文字（选书、按链接还原选书后都要更新）
function updateCompareButtonLabel() {
    const compareBtn = document.getElementById('toggleComparison');
    if (!compareBtn) return;
    if (selectedBooks.size > 1) {
        compareBtn.textContent = `📚 已选 ${selectedBooks.size} 本书进行对比`;
    } else {
        compareBtn.textContent = '⇄ 点击上方书名可多选进行对比';
    }
}

// 按 selectedBooks 同步书名按钮的选中态（链接还原、删除后使用）
function syncBookButtonStates() {
    document.querySelectorAll('.book-group').forEach(group => {
        const btn = group.querySelector('.book-btn');
        if (btn) btn.classList.toggle('active', selectedBooks.has(group.dataset.bookId));
    });
    updateCompareButtonLabel();
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
        updateMetricHint(); // 参考区间跟随当前已加载书集合

        // 确保 selectedBooks 中的书在数据中存在
        const requestedBooks = Array.from(selectedBooks);
        selectedBooks = new Set(requestedBooks.filter(book => availableBooks.includes(book)));
        // 链接里点了名、但这台服务器上已经没有的书：必须说出来。
        // 原来只是悄悄换成第一本书，用户会以为自己看的还是同事分享的那几本。
        const droppedBooks = requestedBooks.filter(book => !availableBooks.includes(book));
        if (droppedBooks.length > 0) {
            setGlobalStatus('notice',
                `链接里的这 ${droppedBooks.length} 本书在这台服务器上找不到：${droppedBooks.map(getBookDisplayName).join('、')}`
                + '（可能已被删除，或链接来自别的部署）。下面显示的是现有的书。');
        }
        if (selectedBooks.size === 0) {
            selectBook(availableBooks[0]); // 如果没选，默认选第一本
        } else {
            syncBookButtonStates(); // 链接还原 / 书籍变动后，把选中态落到按钮上
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
        .text("阅读进度（每个片段约 1 万个单词）");

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
            .attr("aria-label", d => `${getBookDisplayName(bookData.book)} 第 ${d.block + 1} 个片段，${getMetricLabel(currentMetric)} ${formatMetric(d.value)}`)
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
        row.append("text").attr("x", 20).attr("y", 12).text(getBookDisplayName(d.book)).style("font-size", "12px").style("fill", "#5c5346");
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

// 章节分界在热力图网格里的位置：格子按行铺开，分界线画在「该章起始所在那一格」的左边框上
// ——也就是「上一格是上一章、这一格是新的一章」的那条缝。
// 章节特别多时不再画，否则整张图会被虚线填满、反而看不清颜色。
function getChapterGridDividers(bookName, data) {
    const positions = getChapterBlockPositions(bookName);
    if (!positions || positions.length > 60) return [];

    // 正常情况下数组下标就是第几块；万一有片段缺值被过滤掉，按块号回查，避免画错行
    const positionOfBlock = new Map();
    data.forEach((item, index) => positionOfBlock.set(item.block, index));

    // 一个格子可能被相邻几章同时选中（格子覆盖 1 万个词，段落比格子密时就会出现），
    // 同一格只画一次，避免重复叠线。
    const seen = new Set();
    return positions
        .map(item => {
            const position = positionOfBlock.has(item.block) ? positionOfBlock.get(item.block) : item.block;
            return { chapter: item.chapterIndex + 1, position };
        })
        .filter(item => item.chapter > 1 && item.position > 0 && item.position < data.length)
        .filter(item => {
            if (seen.has(item.position)) return false;
            seen.add(item.position);
            return true;
        });
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
    const bottomMargin = 68; // 图例底下还要留一行「虚线是章节分界」的说明

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

    let drewChapterDividers = false;

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
            .attr("role", "button")
            .attr("aria-label", d => `${getBookDisplayName(bookId)} 第 ${d.block + 1} 个片段，${getMetricLabel(currentMetric)} ${formatMetric(d.value)}`)
            .on("mouseover", function(event, d) {
                d3.select(this).style("stroke", "#b5472f").style("stroke-width", "2px");
                showTooltip(event, d, bookId);
            })
            .on("mouseout", function() {
                d3.select(this).style("stroke", "#e4d9c3").style("stroke-width", "1px");
                hideTooltip();
            })
            .on("click", function(event, d) { showDetail(d, bookId); });

        // 键盘导航：整块热力图只占一个 Tab 停靠点，进来后用方向键逐格移动。
        // 一本书上百个格子如果都能 Tab 到，键盘用户要按上百次才能走出去。
        const rects = g.selectAll("rect");
        rects.attr("tabindex", (d, i) => (i === 0 ? 0 : -1));
        rects.on("keydown", function(event, d) {
            const all = rects.nodes();
            const current = all.indexOf(this);
            let next = null;
            if (event.key === 'ArrowRight') next = current + 1;
            else if (event.key === 'ArrowLeft') next = current - 1;
            else if (event.key === 'ArrowDown') next = current + cols;
            else if (event.key === 'ArrowUp') next = current - cols;
            else if (event.key === 'Home') next = current - (current % cols);
            else if (event.key === 'End') next = Math.min(n - 1, current - (current % cols) + cols - 1);
            else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                showDetail(d, bookId);
                return;
            }

            if (next === null) return;
            event.preventDefault();
            if (next < 0 || next >= n) return;
            all.forEach(node => node.setAttribute('tabindex', '-1'));
            all[next].setAttribute('tabindex', '0');
            all[next].focus();
        });

        // 章节分界：虚线，标出「颜色变化大概发生在第几章」
        const dividers = getChapterGridDividers(bookId, data);
        if (dividers.length > 0) {
            const rows = Math.ceil(n / cols);
            const dividerLayer = g.append("g").attr("class", "chapter-dividers");
            dividers.forEach(item => {
                const points = [];
                for (let row = 0; row < rows; row++) {
                    const local = item.position - row * cols; // 这一章起始的格子在当前行的第几列
                    // local === 0 是「这一章正好从某行第一格开始」：分界线要画在这一行的
                    // 最左边。以前写成 local <= 0，等于把这一行整个跳过，结果是这些
                    // 分界线一条都画不出来（实测被吞掉 13 条）。
                    if (local < 0 || local >= cols) continue;
                    const x = local * blockSize;
                    points.push([x, row * blockSize], [x, (row + 1) * blockSize]);
                }
                if (points.length === 0) return;
                dividerLayer.append("path")
                    .attr("d", "M" + points.map(point => point.join(",")).join(" L"))
                    .attr("fill", "none")
                    .attr("stroke", "#3a332a")
                    .attr("stroke-width", 1.2)
                    .attr("stroke-dasharray", "3,3")
                    .attr("opacity", 0.75)
                    .attr("pointer-events", "none");
                drewChapterDividers = true;
            });
        }

        g.append("text")
            .attr("x", (cols * blockSize) / 2)
            .attr("y", -20)
            .attr("text-anchor", "middle")
            .style("font-size", "14px")
            .style("font-weight", "bold")
            .style("fill", "#5c5346")
            .text(truncateText(getBookDisplayName(bookId), 18));
    });

    svg.append("text")
        .attr("x", containerWidth / 2)
        .attr("y", 30)
        .attr("text-anchor", "middle")
        .style("font-size", "18px")
        .style("font-weight", "bold")
        .style("fill", "#2f2a23")
        .text(`${getMetricLabel(currentMetric)} - 指纹对比 (统一色标: ${formatMetric(globalMin)} ~ ${formatMetric(globalMax)})`);

    // 图例：低（黛蓝）↔ 高（赤），并标注当前指标的具体含义
    const [lowLabel, highLabel] = getHeatmapLegend(currentMetric);
    const legendW = 220, legendH = 12;
    const legendX = containerWidth / 2 - legendW / 2;
    const legendY = totalHeight - 46;

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

    // 分界线是自动识别出来的，位置只能算近似，这里如实说明
    if (drewChapterDividers) {
        svg.append("text")
            .attr("x", containerWidth / 2).attr("y", totalHeight - 14)
            .attr("text-anchor", "middle")
            .style("font-size", "11px")
            .style("fill", "#6b6254")
            .text("虚线为章节分界（按章节标题自动识别，位置为近似值；章节过多时不显示）");
    }
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
    // 定位到章节：热力图上那条虚线到底指哪一章，悬停就能看到
    const chapter = typeof getBlockChapter === 'function' ? getBlockChapter(bookName, data.block) : null;
    tooltip.html(`
        <div style="margin-bottom: 5px;">
            <strong>${escapeHtml(getBookDisplayName(bookName))}</strong>
        </div>
        <div style="margin-bottom: 3px;">
            <strong>片段：</strong>第 ${Number(data.block) + 1} 个
        </div>
        ${chapter ? `<div style="margin-bottom: 3px;"><strong>位置：</strong>${escapeHtml(chapterLabel(chapter))}</div>` : ''}
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
    const locationText = formatBlockLocation(bookName, data.block) + formatWordCount(data.wordCount);
    const chapter = getBlockChapter(bookName, data.block);
    const chapterHtml = chapter
        ? `<p class="chapter-location">🔖 所在章节：${escapeHtml(chapterTitle(chapter))} · ${escapeHtml(chapterLabel(chapter))}</p>`
        : '';
    const overviewText = formatBookOverview(bookName);
    const overviewHtml = overviewText
        ? `<p class="book-overview">全书概况：${escapeHtml(overviewText)}</p>`
        : '';
    const sourceText = data.extended_preview || data.preview || '';
    const previewHtml = data.preview ? `
            <div>
                <h4>📄 原文片段</h4>
                <p style="margin-top: 10px; color: #6b6254; font-style: italic;">
                    "${escapeHtml(data.preview)}"
                </p>
                ${sourceText ? copyButtonHtml(sourceText) : ''}
            </div>` : '';

    detailPanel.innerHTML = `
        <h3>▤ 数据详情</h3>
        <p>当前选择：${escapeHtml(displayName)} - ${escapeHtml(getMetricLabel(currentMetric))}</p>
        <div class="detail-card">
            <h3>📖 ${escapeHtml(displayName)}</h3>
            <p class="block-location">📍 ${escapeHtml(locationText)}</p>
            ${chapterHtml}
            <div class="value">${escapeHtml(formatMetric(data.value))}</div>
            <p><strong>${escapeHtml(getMetricLabel(currentMetric))}</strong></p>
            ${overviewHtml}

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
        hapaxLegomena: '独特词丰富度',
        functionWords: '风格走向'
    };
    return labels[metric] || metric;
}

// 当前指标的大白话说明（面向非技术用户）
function updateMetricHint() {
    const el = document.getElementById('metric-hint');
    if (!el) return;
    const hints = {
        sentenceLength: '一句话平均几个词。句子长，读起来更书面、更正式；句子短，更口语、更利落。',
        simpsonIndex: '这本书是不是翻来覆去用同一批词。数值越高越重复（词有点单调）；越低，用词越多样。',
        hapaxLegomena: '「只出现过一次的词」在全书里占多大比例：比例越高，说明作者用词越丰富、越不单调。这个数已经按篇幅折算过，长短不同的书也能比。',
        functionWords: '不看内容，而看「的、和、是」这类高频小词的使用习惯。点越靠近只说明这些词的用法越像，不等于两本书本身相似。'
    };
    const ctxText = getMetricContextLine(currentMetric);
    el.innerHTML = `<span class="metric-hint-label">${escapeHtml(getMetricLabel(currentMetric))}：</span>${escapeHtml(hints[currentMetric] || '')}`;
    if (ctxText) {
        const line = document.createElement('div');
        line.className = 'metric-context';
        line.textContent = ctxText;
        el.appendChild(line);
    }
}

// ==========================================
// 📍 出处定位 / 复制片段（R2）
// ==========================================

function getBookBlockCount(bookName) {
    const bookData = realData && realData[bookName];
    if (!bookData) return 0;
    const n = bookData.metadata && Number(bookData.metadata.totalBlocks);
    if (isFiniteNumber(n) && n > 0) return n;
    for (const metric of ['sentenceLength', 'simpsonIndex', 'hapaxLegomena', 'functionWords']) {
        if (Array.isArray(bookData[metric]) && bookData[metric].length > 0) return bookData[metric].length;
    }
    return 0;
}

// 数据版本兼容：v1 数据没有真实总词数、滑窗参数和章节信息。
// 这里只在内存里补一份推算值，绝不改写磁盘上的旧文件；
// 也绝不把 v1 的 totalWords 当成真实词数（那是重叠窗口累加，比真实词数大近十倍）。
function normalizeBookMeta(bookName) {
    const bookData = realData && realData[bookName];
    const raw = bookData && bookData.metadata;
    if (!raw || typeof raw !== 'object') return null;

    const legacy = Number(raw.schemaVersion) !== 2;
    const totalBlocks = getBookBlockCount(bookName);
    const step = isFiniteNumber(raw.step) && raw.step > 0 ? raw.step : 1000;
    const blockSize = isFiniteNumber(raw.blockSize) && raw.blockSize > 0 ? raw.blockSize : 10000;
    const analyzedWords = isFiniteNumber(raw.analyzedWords)
        ? raw.analyzedWords
        : (legacy && isFiniteNumber(raw.totalWords)
            ? raw.totalWords
            : (totalBlocks > 0 ? (totalBlocks - 1) * step + blockSize : null));

    return {
        legacy,
        totalBlocks,
        totalWords: legacy || !isFiniteNumber(raw.totalWords) ? null : raw.totalWords,
        analyzedWords,
        blockSize,
        step,
        // 相邻片段重叠词数：旧数据没写这个字段，按「窗口长 − 步长」推出来。
        // CSV 注释行要如实说明重叠，缺了它会印成「相邻重叠 undefined 词」。
        overlap: isFiniteNumber(raw.overlap) && raw.overlap >= 0
            ? raw.overlap
            : Math.max(0, blockSize - step),
        chapters: Array.isArray(raw.chapters) && raw.chapters.length > 0 ? raw.chapters : null,
        projection: raw.projection || null
    };
}

// 某一章：片段 i 覆盖第 [i*step, i*step+blockSize) 个词，
// 取片段中点所在的章（跨章片段不会被硬塞给上一章）。
function getBlockChapter(bookName, blockIndex) {
    const meta = normalizeBookMeta(bookName);
    if (!meta || !meta.chapters) return null;
    const idx = Number(blockIndex);
    if (!isFiniteNumber(idx) || idx < 0) return null;
    const center = idx * meta.step + meta.blockSize / 2;
    return meta.chapters.find(ch => center >= ch.wordStart && center < ch.wordEnd) || null;
}

// 章节分界落在第几块（可以带小数）：片段 i 的中点对应第 i*step + blockSize/2 个词，
// 反过来就能把章节标题的词位置换算成片段位置。
// 返回 null 表示这本书没有可用的章节信息。
//
// 一章从「中点落在这一章里的第一个片段」开始：片段 i 的中点在第
// i*step + blockSize/2 个词处，所以这一格就是 ceil((wordStart - blockSize/2) / step)。
// 取整方向不能用 Math.round——小数部分小于 0.5 时该片段的中点还在上一章里，
// 四舍五入会把分界线画到上一章的最后一格上（实测 91 条里有 47 条偏了一格）。
function chapterBlockOf(meta, chapter) {
    const raw = (chapter.wordStart - meta.blockSize / 2) / meta.step;
    return Number.isFinite(raw) ? Math.ceil(raw) : 0;
}

function getChapterBlockPositions(bookName) {
    const meta = normalizeBookMeta(bookName);
    if (!meta || !meta.chapters || meta.chapters.length < 2) return null;

    return meta.chapters.map((chapter, index) => ({
        chapterIndex: index,
        title: chapter.title,
        part: chapter.part || null,
        block: chapterBlockOf(meta, chapter)
    }));
}

// 滑窗在书末就停了：最后一个片段的中点 = (totalBlocks-1)*step + blockSize/2 个词，
// 起点在这之后的章一个片段都没有。这些章在走势图上没有刻度、在热力图里没有分界线，
// 是数据里真的没有，不是画错——所以要照实说，而不是假装章节都在图里。
function chaptersWithoutBlocks(bookName) {
    const meta = normalizeBookMeta(bookName);
    if (!meta || !meta.chapters) return [];
    const lastCenter = (meta.totalBlocks - 1) * meta.step + meta.blockSize / 2;
    return meta.chapters
        .map((chapter, index) => ({ index, wordStart: chapter.wordStart }))
        .filter(chapter => chapter.wordStart > lastCenter)
        .map(chapter => chapter.index + 1);
}

// 章号一律带口径说明：这是按章节标题自动识别出来的，不是人工标注的章号。
// 分「部」的小说（《白牙》每部从 CHAPTER I 重新编号）尤其需要——第 16 章的
// 原始标题确实写着 CHAPTER II，不加说明就成了自相矛盾的两句话。
function chapterLabel(chapter) {
    return chapter ? `第 ${chapter.index + 1} 章（按标题自动识别）` : '';
}

// 章节标题：有「部」时带上部名，否则只显示原始标题。
function chapterTitle(chapter) {
    if (!chapter || !chapter.title) return '';
    return chapter.part ? `${chapter.part} · ${chapter.title}` : chapter.title;
}

function formatBlockLocation(bookName, blockIndex) {
    const idx = Number(blockIndex);
    const count = getBookBlockCount(bookName);
    if (!isFiniteNumber(idx) || idx < 0 || count <= 0) return '暂无全书定位';
    const chapter = getBlockChapter(bookName, idx);
    const chapterPart = chapter ? ` · ${chapterLabel(chapter)}` : '';
    return `第 ${idx + 1}/${count} 个片段${chapterPart} · 约全书 ${(((idx + 1) / count) * 100).toFixed(1)}%`;
}

// 全书概况：详情面板里给一次「这本书有多长、怎么切的、识别到几章」
function formatBookOverview(bookName) {
    const meta = normalizeBookMeta(bookName);
    if (!meta) return '';
    const parts = [];
    if (isFiniteNumber(meta.totalWords)) {
        parts.push(`全书约 ${meta.totalWords.toLocaleString('zh-CN')} 词`);
    } else if (isFiniteNumber(meta.analyzedWords)) {
        // 老数据没有真实总词数，只能给出滑窗覆盖的词次，如实说明
        parts.push(`全书长度未记录（按窗口推算约 ${Math.round(meta.analyzedWords).toLocaleString('zh-CN')} 词次）`);
    }
    parts.push(`切成 ${meta.totalBlocks} 个片段`);
    parts.push(`每段 ${meta.blockSize.toLocaleString('zh-CN')} 词、相邻段重叠 ${meta.blockSize - meta.step > 0 ? (meta.blockSize - meta.step).toLocaleString('zh-CN') : 0} 词`);
    if (meta.chapters) {
        parts.push(`自动识别到 ${meta.chapters.length} 章`);
        const tail = chaptersWithoutBlocks(bookName);
        if (tail.length > 0) {
            parts.push(`其中末尾 ${tail.length} 章（第 ${tail[0]} 章起）在滑动窗口的截断范围内，没有对应片段`);
        }
    } else {
        parts.push('未识别到章节标题');
    }
    return parts.join(' · ');
}

function formatWordCount(wordCount) {
    const wc = Number(wordCount);
    if (!isFiniteNumber(wc) || wc <= 0) return '';
    return ` · 本片段约 ${wc.toLocaleString('zh-CN')} 词`;
}

// 复制原文片段。原文（可能含引号/换行/CJK）不进 HTML 属性：
// 先存入内存注册表，按钮只带数字索引，由全局委托统一处理点击。
const _copySources = [];

function registerCopySource(text) {
    return _copySources.push(String(text ?? '')) - 1;
}

function copyButtonHtml(text, extraClass = '') {
    if (!text) return '';
    return `<button type="button" class="copy-block-btn${extraClass ? ` ${extraClass}` : ''}" data-copy-idx="${registerCopySource(text)}">⧉ 复制片段</button>`;
}

function copyFromButton(button) {
    const idx = Number(button && button.dataset.copyIdx);
    const text = _copySources[idx];
    if (text === undefined) return;
    copyTextToClipboard(text, button, '✓ 已复制');
}

// 复制按钮的反馈。两件事必须做对：
//   1) 原文案存在 dataset 里——原来每次点都把当前 innerHTML 当成原文案，
//      1.6 秒内连点两次就会把「✓ 已复制」存下来，按钮从此卡死在提示语上；
//   2) 失败要说出来——http 站点（非安全上下文）没有 navigator.clipboard，
//      走 execCommand 兜底也可能被浏览器拒绝，原来是彻底静默的，用户以为复制好了。
function flashCopyButton(button, ok, okText) {
    if (!button) return;
    if (button.dataset.copyLabel === undefined) {
        button.dataset.copyLabel = button.innerHTML;
        button.dataset.copyTitle = button.title || '';
    }
    if (button._copyTimer) clearTimeout(button._copyTimer);
    button.textContent = ok ? okText : '请手动复制（Ctrl+C）';
    button.classList.toggle('copy-failed', !ok);
    button.title = ok ? button.dataset.copyTitle : '复制没成功，请手动选中后按 Ctrl+C';
    button._copyTimer = setTimeout(() => {
        button.innerHTML = button.dataset.copyLabel;
        button.title = button.dataset.copyTitle;
        button.classList.remove('copy-failed');
        button._copyTimer = null;
    }, ok ? 1600 : 4000);
}

function copyTextToClipboard(text, button, okText = '✓ 已复制') {
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text)
            .then(() => { flashCopyButton(button, true, okText); return true; })
            .catch(() => { const ok = fallbackCopyText(text); flashCopyButton(button, ok, okText); return ok; });
    }
    // http 等非安全上下文必须走 execCommand 兜底
    const ok = fallbackCopyText(text);
    flashCopyButton(button, ok, okText);
    return Promise.resolve(ok);
}

// 返回是否真的复制成功——调用方要据此给用户反馈，不能再默默失败
function fallbackCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
}

document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-copy-idx]');
    if (target) copyFromButton(target);
});

// ==========================================
// 📏 指标解读参考区间（R3）：纯数据驱动，不编造固定阈值
// ==========================================

// 一批书的指标均值范围（只看有数据的书）
function getMetricMeanRange(bookNames, metric) {
    const means = bookNames
        .map(name => {
            const values = getMetricValues(name, metric).map(d => d.value);
            return values.length > 0 ? d3.mean(values) : null;
        })
        .filter(isFiniteNumber);
    if (means.length === 0) return null;
    return { count: means.length, min: d3.min(means), max: d3.max(means) };
}

function getMetricContextLine(metric) {
    if (!realData) return '';
    const loaded = Object.keys(realData);
    if (loaded.length === 0) return '';

    // 基准用「服务器上常驻的示例书」——用户自己的书不该拿来当参照物；
    // 没有内置书（例如只有自己上传的书）时退回全部已加载的书
    const builtinLoaded = builtinBookNames.filter(name => loaded.includes(name));
    const baselineNames = builtinLoaded.length > 0 ? builtinLoaded : loaded;
    const baseline = getMetricMeanRange(baselineNames, metric);

    const selectedNames = Array.from(selectedBooks);
    const selected = getMetricMeanRange(selectedNames, metric);
    const sameAsBaseline = selectedNames.length === baselineNames.length
        && selectedNames.every(name => baselineNames.includes(name));

    const parts = [];
    if (baseline) {
        const label = builtinLoaded.length > 0 ? '内置示例书' : '当前已加载的书';
        parts.push(`参考区间：${label}（${baseline.count} 本）的平均水平大致在 ${formatMetric(baseline.min)} – ${formatMetric(baseline.max)}，这只是个参照，不是好坏标准。`);
    }
    if (selected && !sameAsBaseline) {
        parts.push(`你选中的 ${selected.count} 本在 ${formatMetric(selected.min)} – ${formatMetric(selected.max)} 之间。`);
    }
    if (parts.length === 0) return '';

    let line = parts.join(' ');
    if (metric === 'hapaxLegomena') {
        line += ' 独特词丰富度已经按片段篇幅折算过，长短不同的片段与书之间都可以比。';
    } else if (metric === 'functionWords') {
        line += ' 「风格走向」只是高频小词用法的一个参照方向，请结合原文理解。';
    }
    return line;
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
        hapaxLegomena: ['用词较单调', '用词较丰富'],
        functionWords: ['一端', '另一端']
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

// 导出的必须是「眼前这一张图」。
// 旧写法写死 #main-chart，于是在「风格星系」「全书对比」下点导出，
// 拿到的仍是基础趋势的热力图，跟屏幕上的图不是一回事。
function getExportTarget() {
    if (currentTab === 'view-galaxy') {
        return { element: document.querySelector('#galaxy-container svg'), label: '风格星系' };
    }
    if (currentTab === 'view-dashboard') {
        const element = document.querySelector('#adv-mean svg') || document.querySelector('#adv-line svg');
        return { element, label: '全书对比' };
    }
    return {
        element: document.getElementById('main-chart'),
        label: chartType === 'line' ? '折线趋势图' : '指纹热力图'
    };
}

// 文件名里的书：多本时不再只写第一本的名字（导出的是对比图，不是单书图）
function exportFileLabel() {
    const books = Array.from(selectedBooks);
    if (books.length === 0) return 'Comparison';
    if (books.length > 1) return '多书对比';
    return books[0].replace(/\s+/g, '_');
}

// 导出的按钮在三个页签下都看得到，但目标 svg 是各视图渲染时才建的。
// 拿不到时给一句能自处的话，别只说「找不到图表元素」。
function getNoChartMessage() {
    const where = currentTab === 'view-galaxy' ? '风格星系' : (currentTab === 'view-dashboard' ? '全书对比' : '基础趋势分析');
    return `「${where}」这张图还没画出来，暂时没有可导出的内容。`
        + '请先在有数据的书上点一下，或稍等图渲染完成再试。';
}

function exportChart() {
    const target = getExportTarget();
    const svg = target.element;
    if (!svg) {
        showError(getNoChartMessage());
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

        link.download = `文印_${exportFileLabel()}_${target.label}_${timestamp}.png`;
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
        showError('当前选择的书籍暂时没有可用于这个观察角度的数据，请换一个角度，或换一本书再试。');
        return;
    }

    const metricLabel = getMetricLabel(currentMetric);
    const metricHint = {
        sentenceLength: '一句话平均几个词。',
        simpsonIndex: '数值越高，用词越重复。',
        hapaxLegomena: '「只出现过一次的词」占比越高，用词越丰富；这个数已按篇幅折算，长短不同的书可比。',
        functionWords: '由「的、和、是」这类高频小词的使用习惯得出，仅作参照。'
    }[currentMetric] || '';
    const contextLine = getMetricContextLine(currentMetric);
    const lines = [
        '# 文印·文学指纹分析摘要',
        '',
        `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
        `- 当前视图：${currentTab === 'view-main' ? (chartType === 'line' ? '基础趋势分析 · 折线趋势图' : '基础趋势分析 · 指纹热力图') : currentTab === 'view-galaxy' ? '风格星系' : '全书对比'}`,
        `- 观察角度：${metricLabel}`,
        `- 怎么理解：${metricHint}`,
        ...(contextLine ? [`- 解读参考：${contextLine}`] : []),
        `- 选择书籍：${books.map(getBookDisplayName).join('、')}`,
        `- 在线视图（打开即还原本次选择）：${buildStateUrl()}`,
        ''
    ];

    books.forEach(book => {
        const values = getMetricValues(book, currentMetric);
        const mean = d3.mean(values, d => d.value);
        const peak = values.reduce((best, current) => current.value > best.value ? current : best, values[0]);
        lines.push(`## ${getBookDisplayName(book)}`);
        lines.push(`- 参与统计的片段数：${values.length}`);
        lines.push(`- 全书范围：全书共 ${getBookBlockCount(book)} 个片段 · 本次分析其中 ${values.length} 个片段`);
        lines.push(`- 平均水平：${formatMetric(mean)}`);
        lines.push(`- 最高片段：第 ${Number(peak.block) + 1} 个片段，数值 ${formatMetric(peak.value)}`);
        lines.push(`- 片段位置：${formatBlockLocation(book, peak.block)}${formatWordCount(peak.wordCount)}`);
        if (Array.isArray(peak.keywords) && peak.keywords.length > 0) {
            lines.push(`- 最高片段关键词：${peak.keywords.join('、')}`);
        }
        if (peak.preview) {
            lines.push(`- 原文片段：${String(peak.preview).replace(/\r?\n/g, ' ').trim().substring(0, 240)}`);
        }
        lines.push('');
    });

    // 方法说明：写清这次是怎么算的，别人照着能复现
    const methods = buildMethodsParagraph(books);
    if (methods) {
        lines.push('## 方法说明');
        lines.push(methods);
        lines.push('');
    }

    lines.push('> 说明：本摘要用于记录当前页面的选择。图中的数值与位置只是风格方面的数据，请结合作品原文与具体片段理解，不宜单独当作文学质量高低的评判。');

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

// ==========================================
// ⤓ 导出：数据表 / 引用 / 矢量图
// ==========================================

function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const link = document.createElement('a');
    link.download = filename;
    link.href = URL.createObjectURL(blob);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
}

function exportTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// 导出的书名清单：当前选中、且在这个观察角度下确实有数据
function getExportBooks() {
    if (!realData || selectedBooks.size === 0) return [];
    return Array.from(selectedBooks).filter(book => getMetricValues(book, currentMetric).length > 0);
}

// 按片段序号取出某指标的原始条目（按 block 对齐，避免四个指标之间错位）
function getBlockSeriesMap(bookName, metric) {
    const map = new Map();
    const series = realData && realData[bookName] ? realData[bookName][metric] : null;
    if (Array.isArray(series)) {
        series.forEach(item => {
            if (item && isFiniteNumber(item.block)) map.set(Number(item.block), item);
        });
    }
    return map;
}

// 选中书籍的共同坐标基底。
//
// 关键点：判定必须落在「本次选中的每一本」上。旧写法先 filter 掉没有投影的书
// （v1 数据没有 projection 字段）再判断剩下的全共享，于是混选一本旧书时
// 摘要照样宣称「各书坐标落在同一基底上，可直接比较」——当着旧书的面说假话。
function getSharedProjection(books) {
    const entries = books.map(name => {
        const meta = normalizeBookMeta(name);
        return { name, projection: meta ? meta.projection : null };
    });
    const legacy = entries.filter(e => !e.projection || e.projection.mode !== 'shared' || !e.projection.modelId);
    const modelIds = new Set(entries.map(e => e.projection && e.projection.modelId).filter(Boolean));
    const allShared = entries.length > 0 && legacy.length === 0 && modelIds.size === 1;

    return {
        model: allShared ? entries[0].projection : null,
        allShared,
        legacyBooks: legacy.map(e => e.name),
        mixedModels: legacy.length === 0 && modelIds.size > 1
    };
}

// 跨书比较是否成立，用一句话说清楚；不成立时点名是哪几本拖了后腿
function buildComparabilitySentence(books) {
    const { model, allShared, legacyBooks, mixedModels } = getSharedProjection(books);
    if (allShared) {
        const ratio = (model.explainedVarianceRatio || []).map(v => `${(v * 100).toFixed(1)}%`).join(' / ');
        return `功能词投影由统一的坐标模型计算（模型编号 ${model.modelId}${ratio ? `，前两个主成分解释方差 ${ratio}` : ''}），因此各书的坐标落在同一基底上，可直接比较。`;
    }
    if (legacyBooks.length > 0) {
        const names = legacyBooks.map(name => `《${getBookDisplayName(name)}》`).join('、');
        return `功能词投影由统一的坐标模型计算，但${names}是旧版数据、没有共同坐标基准，${legacyBooks.length > 1 ? '这几本' : '这一本'}的坐标不参与跨书比较；其余书之间可直接比较。`;
    }
    if (mixedModels) {
        return '选中的书来自不同的坐标模型，坐标没有落在同一基底上，不宜跨书解读。';
    }
    return '功能词坐标由各书单独拟合，只可在同一本书内部比较，不宜跨书解读。';
}

// 方法说明（自动生成）：把这次分析用的参数如实写下来，别人照着能复现
function buildMethodsParagraph(books) {
    const metas = books.map(name => normalizeBookMeta(name)).filter(Boolean);
    if (metas.length === 0) return '';

    const blockSizes = Array.from(new Set(metas.map(meta => meta.blockSize)));
    const steps = Array.from(new Set(metas.map(meta => meta.step)));
    const totalBlocks = metas.reduce((sum, meta) => sum + (meta.totalBlocks || 0), 0);
    const chapterCounts = metas.map(meta => (meta.chapters ? meta.chapters.length : 0)).filter(n => n > 0);

    const parts = [];
    parts.push(`本次分析使用「文印」文学指纹工具，共分析 ${books.length} 本书、${totalBlocks} 个文本块。`);
    parts.push(`文本经 Project Gutenberg 页眉页脚清理与常见缩写还原后，按每块 ${blockSizes.join('/')} 词、相邻块重叠 ${blockSizes.map((size, i) => size - steps[i]).join('/')} 词的滑动窗口切分。`);
    parts.push('计算指标包括平均句长、用词重复度（Simpson\'s D）、独特词丰富度（Honoré R）与功能词二维投影。');
    parts.push(buildComparabilitySentence(books));
    if (chapterCounts.length > 0) {
        parts.push(`章节边界由章节标题自动识别（本次识别到 ${chapterCounts.join('、')} 章），用于定位片段所在的章节；章号是识别结果，不是人工标注的章号。`);
    }
    parts.push(`生成时间：${new Date().toLocaleString('zh-CN')}。在线视图：${buildStateUrl()}`);
    return parts.join('');
}

// 导出数据表（CSV）：每个片段一行，四个指标并列，可直接用 Excel / R / SPSS 打开
function exportTableData() {
    const books = getExportBooks();
    if (books.length === 0) {
        showError('当前没有可导出的分析数据。请先选择书籍或上传文本。');
        return;
    }

    const header = ['书名', '片段序号', '所在章节', '起始词位置', '平均句长', '用词重复度', '独特词丰富度', '风格走向_横轴', '风格走向_纵轴', '关键词'];
    const rows = [header];

    books.forEach(book => {
        const meta = normalizeBookMeta(book);
        const totalBlocks = getBookBlockCount(book);
        const series = {
            sentenceLength: getBlockSeriesMap(book, 'sentenceLength'),
            simpsonIndex: getBlockSeriesMap(book, 'simpsonIndex'),
            hapaxLegomena: getBlockSeriesMap(book, 'hapaxLegomena'),
            functionWords: getBlockSeriesMap(book, 'functionWords')
        };

        for (let i = 0; i < totalBlocks; i += 1) {
            const chapter = getBlockChapter(book, i);
            const words = series.functionWords.get(i) || series.sentenceLength.get(i) || {};
            const value = (key) => {
                const item = series[key].get(i);
                return item && isFiniteNumber(item.value) ? String(item.value) : '';
            };
            const style = series.functionWords.get(i);
            rows.push([
                book,
                String(i + 1),
                chapter ? `${chapterLabel(chapter)} ${chapterTitle(chapter)}` : '',
                meta ? String(i * meta.step + 1) : '', // 起始词位置从第 1 个词数起
                value('sentenceLength'),
                value('simpsonIndex'),
                value('hapaxLegomena'),
                style && isFiniteNumber(style.value) ? String(style.value) : '',
                style && isFiniteNumber(style.value_y) ? String(style.value_y) : '',
                Array.isArray(words.keywords) ? words.keywords.join(' ') : ''
            ]);
        }
    });

    const body = rows.map(row => row.map(cell => {
        const text = String(cell ?? '');
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(',')).join('\r\n');

    // 表头前的注释行：滑动窗口是重叠切分，相邻片段共享 9000 个词，
    // 不写清楚的话，63 行很容易被当成 63 个互相独立的样本拿去做统计检验。
    // 以 # 开头是 CSV 的通行注释约定（pandas 用 comment='#'、R 用 comment.char='#' 即可跳过）。
    const windowSpecs = Array.from(new Set(books.map(name => {
        const meta = normalizeBookMeta(name);
        return meta && isFiniteNumber(meta.blockSize) && isFiniteNumber(meta.overlap) && isFiniteNumber(meta.step)
            ? `每段 ${meta.blockSize} 词 · 相邻重叠 ${meta.overlap} 词 · 步长 ${meta.step} 词`
            : '窗口参数未知';
    })));
    const comments = [
        '# 文印·文学指纹分析 数据表',
        `# 生成时间：${new Date().toLocaleString('zh-CN')}`,
        `# 指标口径：平均句长（词/句）；用词重复度（Simpson，越高越重复）；独特词丰富度（Honoré R，越高用词越丰富）；风格走向_横/纵轴（高频小词用法的二维坐标）`,
        `# 片段口径：${windowSpecs.join('；')}。同一段原文会被反复计入，请勿把这些行当作互相独立的样本，按行做显著性检验会高估样本量。`,
        `# 数据行数：${rows.length - 1}`
    ];

    // 带 BOM：Excel 打开中文 CSV 默认按本地编码解析，没有 BOM 会乱码
    const csv = `${comments.join('\r\n')}\r\n${body}`;
    downloadBlob('﻿' + csv, `文印_数据表_${exportTimestamp()}.csv`, 'text/csv;charset=utf-8');
}

// 导出引用条目（BibTeX）：给报告、论文的参考文献用
function exportCitation() {
    const books = getExportBooks();
    if (books.length === 0) {
        showError('当前没有可导出的分析数据。请先选择书籍或上传文本。');
        return;
    }

    const metas = books.map(name => normalizeBookMeta(name)).filter(Boolean);
    const totalBlocks = metas.reduce((sum, meta) => sum + (meta.totalBlocks || 0), 0);
    // 只有在选中书共用同一个模型时才敢把模型编号写进条目
    const sharedModel = getSharedProjection(books).model;
    const now = new Date();
    // key 必须唯一：只写年月日的话，同一天导两次（换个观察角度、换几本书）就会撞 key，
    // 文献管理软件会把两条当成同一条。补上时分，再补一个书名首字，尽量不撞。
    const key = `wenxin${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
        + `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
        + (books.length ? `-${books.length}book` : '');
    const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    // 本机打开时 url 是 localhost，别人点开是打不开的，得在 note 里说清楚
    const localUrlNote = isLocalHost() ? '；在线视图为本机地址（localhost），仅供本机打开' : '';

    // 每个字段末尾都要有逗号（BibTeX 靠逗号分字段，漏一个会整条报错、
    // 丢掉除标题外的全部字段）；最后一行 url 后面不能有逗号。
    // 这条记录描述的是「本次在线分析」，不是正式出版物，写进参考文献前请自己确认该引什么。
    const entry = [
        `@misc{${key},`,
        `  title        = {文印·文学指纹分析：${books.map(name => `{${getBookDisplayName(name)}}`).join('、')}},`,
        `  author       = {{文印（文学指纹分析工具）}},`,
        `  year         = {${now.getFullYear()}},`,
        `  month        = {${monthNames[now.getMonth()]}},`,
        `  howpublished = {在线交互式分析（Keim \\& Oelke 2007 指标口径）},`,
        `  note         = {观察角度：${getMetricLabel(currentMetric)}；分析片段数：${totalBlocks}${sharedModel ? `；坐标模型：${sharedModel.modelId}` : ''}${localUrlNote}；本条描述的是本文档生成时的一次在线分析记录，并非正式出版物，正式引用请以原著版本为准},`,
        `  url          = {${buildStateUrl()}}`,
        '}',
        ''
    ].join('\n');

    downloadBlob(entry, `文印_引用_${exportTimestamp()}.bib`, 'application/x-bibtex;charset=utf-8');
}

// 导出矢量图（SVG）：论文排版放大不糊
function exportVectorChart() {
    const target = getExportTarget();
    const svg = target.element;
    if (!svg) {
        showError(getNoChartMessage());
        return;
    }

    let source = new XMLSerializer().serializeToString(svg);
    if (!source.match(/^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)) {
        source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    const styleString = `
        <style>
            text { font-family: 'Microsoft YaHei', sans-serif; fill: #2f2a23; }
            .heatmap-rect { stroke: #e4d9c3; stroke-width: 1px; }
            .axis path, .axis line { fill: none; stroke: #98907f; shape-rendering: crispEdges; }
        </style>`;
    source = source.replace('</svg>', styleString + '</svg>');

    downloadBlob(source, `文印_${exportFileLabel()}_${target.label}_${exportTimestamp()}.svg`, 'image/svg+xml;charset=utf-8');
}

// 顶部全局状态条：三个标签页都能看到。
// 这一批 show* 原来只写 #detailPanel，而 #detailPanel 长在 #view-main 里，
// 于是切到「风格星系」「全书对比」之后，加载失败、分析失败、无数据全是静默的。
let _globalStatusTimer = null;

function setGlobalStatus(kind, message) {
    const el = document.getElementById('global-status');
    if (!el) return;
    if (_globalStatusTimer) { clearTimeout(_globalStatusTimer); _globalStatusTimer = null; }
    if (!message) {
        el.hidden = true;
        el.textContent = '';
        el.className = 'global-status';
        return;
    }
    el.hidden = false;
    el.className = `global-status ${kind || ''}`.trim();
    el.textContent = message;
    // 「成功」「提示」过几秒自己收起，免得一条过期消息一直挂在页面上；
    // 「错误」「加载中」留在原地，等下一次状态更新来替换。
    if (kind === 'success' || kind === 'notice') {
        _globalStatusTimer = setTimeout(() => setGlobalStatus(null, ''), 6000);
    }
}

// 星系图的「正在加载…」占位：成功时隐藏，失败时改成能看懂的原因。
// 不然它那句初始文案会永远留在画布正中间。
function setGalaxyLoading(text) {
    const el = document.getElementById('galaxy-loading');
    if (!el) return;
    if (text === null || text === undefined) {
        el.style.display = 'none';
        return;
    }
    el.style.display = 'block';
    el.textContent = text;
}

// 星系图画不出来（画布里连 svg 都没有）时，把原因写在画布中间，而不是只丢进主视图的详情面板
function showGalaxyError(message) {
    const container = document.getElementById('galaxy-container');
    if (!container || container.querySelector('svg')) return;
    setGalaxyLoading(message);
}

function showLoading(message) {
    setGlobalStatus('loading', message);
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
    setGlobalStatus('success', message);
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
    setGlobalStatus('error', message);
    showGalaxyError(message);
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
    setGlobalStatus('notice', message);
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
        setGalaxyLoading('请先在上方选择书籍');
        return;
    }

    // 可比的（同一个坐标基底）才画进同一张图；实在一本可比都没有时，
    // 退回各书各自的坐标来画，只是下面会明确写清「不可直接比较」
    const comparability = getGalaxyComparability(books);
    const independentMode = comparability.plotBooks.length === 0;
    const plotBooks = independentMode ? books : comparability.plotBooks;
    const skippedBooks = new Set(independentMode ? [] : comparability.independentBooks);

    const container = document.getElementById('galaxy-container');
    // 如果容器不可见（clientWidth=0）就先别画，否则会算出一堆 NaN。
    // 但也不能直接 return：刚从别的页签切过来时布局可能还没完成，
    // 一走了之的话「正在加载…」会永远留在画布中间。这里重试有限次，超时就如实说明。
    if (!container || container.clientWidth === 0) {
        const tries = (container && container.dataset.galaxyRetry) ? Number(container.dataset.galaxyRetry) : 0;
        if (!container) return;
        if (tries < 20) {
            container.dataset.galaxyRetry = String(tries + 1);
            requestAnimationFrame(() => initStyleGalaxy());
        } else {
            setGalaxyLoading('图没能画出来：容器尺寸为 0。请切到别的页签再切回来试试。');
        }
        return;
    }
    delete container.dataset.galaxyRetry;

    const width = container.clientWidth;
    const height = container.clientHeight;

    d3.select("#galaxy-container").selectAll("svg").remove();
    setGalaxyLoading(null);

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
            if (skippedBooks.has(book)) {
                item.classList.add('galaxy-legend-skipped');
                item.appendChild(document.createTextNode('（未画入）'));
            }
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
    let droppedBlocks = 0;

    plotBooks.forEach((bookName) => {
        const positionData = getMetricValues(bookName, 'functionWords');
        const displayData = getMetricValues(bookName, currentMetric);

        if (positionData.length && displayData.length) {
            positionData.forEach((d, i) => {
                const metricItem = displayData[i];
                if (!metricItem || !isFiniteNumber(d.value) || !isFiniteNumber(metricItem.value)) return;
                // 没有第二个坐标就画不出位置，宁可少画一个点也不编一个
                if (!isFiniteNumber(d.value_y)) {
                    droppedBlocks += 1;
                    return;
                }

                allNodes.push({
                    id: `${bookName}_${d.block}`,
                    book: bookName,
                    blockIndex: d.block,
                    pcaX: d.value,
                    pcaY: d.value_y,
                    realValue: metricItem.value,
                    preview: metricItem.preview,
                    extendedPreview: d.extended_preview || metricItem.preview,
                    wordCount: isFiniteNumber(d.wordCount) ? d.wordCount : metricItem.wordCount,
                    keywords: metricItem.keywords
                });
            });
        }
    });

    renderGalaxyNote(comparability, null, droppedBlocks);

    if (allNodes.length === 0) {
        if (loadingEl) {
            loadingEl.style.display = 'block';
            loadingEl.textContent = "这几本书暂时缺少生成风格星系所需的高频小词数据。请换几本书再试。";
        }
        return;
    }

    const metricExtent = normalizeExtent(d3.extent(allNodes, d => d.realValue));
    const radiusScale = d3.scaleSqrt()
        .domain(metricExtent)
        .range([4, 18]);

    const galaxyExtent = resolveGalaxyExtent(allNodes, independentMode ? null : comparability.axisExtent);
    const xExtent = galaxyExtent.x;
    const yExtent = galaxyExtent.y;
    const padding = 60;
    const xScale = d3.scaleLinear().domain(xExtent).range([padding, width - padding]);
    const yScale = d3.scaleLinear().domain(yExtent).range([padding, height - padding]);
    renderGalaxyNote(comparability, galaxyExtent, droppedBlocks);

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
        .attr("aria-label", d => `${getBookDisplayName(d.book)} 第 ${d.blockIndex + 1} 个片段，${getMetricLabel(currentMetric)} ${formatMetric(d.realValue)}`)
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
            value: formatMetric(d.realValue),
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
            hud.querySelector('.hud-content').innerHTML = '<p style="color:#6b6254; font-size:12px;">将鼠标移到任意圆点上，查看这一片区域的风格特征。</p>';
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
    if (blockEl) {
        const loc = formatBlockLocation(d.book, d.blockIndex) + formatWordCount(d.wordCount);
        blockEl.textContent = loc || `第 ${Number(d.blockIndex) + 1} 个片段`;
    }

    const valDisplay = formatMetric(d.realValue);
    const metricEl = document.getElementById('modal-metric-val');
    if (metricEl) metricEl.textContent = `${getMetricLabel(currentMetric)}：${valDisplay}`;

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
            empty.style.color = '#6b6254';
            empty.textContent = '无关键词';
            keywordContainer.appendChild(empty);
        }
    }

    const textContainer = document.getElementById('modal-long-text');
    if (textContainer) textContainer.textContent = d.extendedPreview || d.preview || "暂无详细文本内容...";

    const modalCopyBtn = document.getElementById('modal-copy-btn');
    if (modalCopyBtn) {
        const txt = d.extendedPreview || d.preview || '';
        if (txt) {
            modalCopyBtn.dataset.copyIdx = registerCopySource(txt);
            modalCopyBtn.hidden = false;
        } else {
            modalCopyBtn.hidden = true;
        }
    }

    modal.setAttribute('aria-hidden', 'false');
    modal.style.display = 'flex';
    document.addEventListener('keydown', trapModalFocus);
    setTimeout(() => {
        modal.classList.add('show');
        const closeButton = modal.querySelector('.galaxy-modal-close');
        if (closeButton) closeButton.focus();
    }, 10);
}

// 键盘焦点陷阱：弹窗打开时 Tab 只在弹窗内部循环，
// 否则焦点会跑到背后看不见的页面上，读屏用户会彻底迷失
function trapModalFocus(event) {
    const modal = document.getElementById('galaxy-modal');
    if (!modal || event.key !== 'Tab') return;

    const focusables = Array.from(
        modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter(el => !el.hidden && el.offsetParent !== null);
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function closeGalaxyModal() {
    const modal = document.getElementById('galaxy-modal');
    if (!modal) return;

    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', trapModalFocus);
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
        content.innerHTML = `<p style="color:#6b6254; font-size:12px;">正在分析这片区域的风格...</p>`;
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
            <span class="hud-value" style="color:#b5472f">${formatMetric(analysisData.avgMetric)}</span>
        </div>
        <div class="hud-row" style="margin-top:8px;">
            <span class="hud-label">共同关键词:</span>
        </div>
        <div class="hud-tags">
            ${analysisData.topKeywords.map(k => `<span class="hud-tag">${k}</span>`).join('')}
        </div>
        <div style="margin-top:10px; padding-top:5px; border-top:1px dashed rgba(46, 42, 36, 0.12); font-size:10px; color:#6b6254;">
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

function setMatrixRain(on) {
    const canvas = document.getElementById('matrix-canvas');
    const btn = document.getElementById('btn-matrix');
    if (!canvas || !btn) return;

    isMatrixOn = !!on;

    if (isMatrixOn) {
        initMatrixRain();
        canvas.classList.add('active');
        btn.classList.add('active');
        btn.innerHTML = "■ 停止文本雨";
        btn.setAttribute('aria-pressed', 'true');
    } else {
        canvas.classList.remove('active');
        btn.classList.remove('active');
        btn.innerHTML = "⋮ 激活文本雨";
        btn.setAttribute('aria-pressed', 'false');

        setTimeout(() => {
            if (matrixInterval) clearInterval(matrixInterval);
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }, 1000);
    }
}

function toggleMatrixRain() {
    setMatrixRain(!isMatrixOn);
}

// 系统是否要求「减少动态效果」。只用于决定默认状态，手动开关不受影响。
function prefersReducedMotion() {
    try {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
        return false;
    }
}