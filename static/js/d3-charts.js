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

// 这行和下面那句隐私说明一起，构成首屏那条常驻提示。原来两句加起来约 130 字，1000px 宽的
// 窗口里要折三行、整条 120px 高，而其中「勾选「存入我的图书馆」后……」半句与勾选框自己的
// title 逐字重复（那个 title 里说得很完整），删掉；剩下的隐私告知必须留在明面上——折进
// 抽屉反而是想藏起来的样子——所以是压缩措辞，不是折叠。
const DEFAULT_UPLOAD_STATUS = '支持英文 .txt，建议 1 万词以上；超长篇（几十万词）请分次上传。';

// 全局变量
let realData = null;
let currentMetric = 'sentenceLength';
let selectedBooks = new Set();
let smoothness = 3;
let chartType = 'heatmap';
let currentTab = 'view-main'; // 记录当前标签页
let builtinBookNames = [];    // 服务器上常驻的示例书（用作解读参照基准，不含用户自己上传的）

// 「全书对比」页那两块结论的最近一次渲染结果，由页面内另一段脚本在渲染时写入
// （本文件先于那段脚本加载，所以在这里声明不会撞上暂时性死区）。导出摘要与
// 「复制结论」都读它——屏幕上是哪几句，导出的就是哪几句，不另算一套。
let lastInsightLines = [];    // 一句话解读（含框选口径说明那句）
// 值得一看的片段：**每本书一条** {book, displayName, metricLabel, mean, brushScoped, items}。
// 顺序与「全书对比」页当前选中的书一致；某本书的请求还没回来时那一格是 null。
// 以前这里是单个对象，只装得下第一本书——同屏选了好几本时，屏幕和导出里都只有
// 第一本的偏离片段，而同页左边的「一句话解读」早就逐本遍历了。
let lastAnomalyReports = [];
// 与 lastAnomalyReports 一一对应的书名表（{name, displayName}），顺序即面板上的顺序。
// 面板重绘、以及「这本书的报告还没回来」时要显示哪本书的名字，都得靠它。
let lastAnomalyBooks = [];

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
    trackDashboardCharts();
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

    // 按链接还原视图时不滚：这时数据还没到、三个视图都是空盒子，滚过去只会落在
    // 一个「正在加载…」上；而且浏览器自己的滚动位置还原会跟这里抢。
    // 打开链接的人该先看到的是「这台机器上有哪些书、选中了哪几本」。
    if (state.tab) window.switchTab(state.tab, { scroll: false });

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
    // 「全书对比」页上以该页的书籍筛选为准，链接打开后看到的就是同一批书
    const books = Array.from(getActiveBookSet());
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
    // 链接里只带书名。内置书在别人的服务器上也有，自己上传的那几本没有——对方打开时
    // 那几本会静默消失（url 里那个名字对不上任何一本书），而复制的人以为分享的是完整结果。
    // 所以复制前先点名。builtinBookNames 还没建好时（书单还在加载）不做判断，免得全被当成上传的。
    const uploaded = builtinBookNames.length === 0
        ? []
        : Array.from(getActiveBookSet()).filter(name => !builtinBookNames.includes(name));
    const okText = uploaded.length ? `✓ 链接已复制（不含你上传的 ${uploaded.length} 本）` : '✓ 链接已复制';
    copyTextToClipboard(buildStateUrl(), button, okText);
    if (uploaded.length > 0) {
        const names = uploaded.map(getBookDisplayName).join('、');
        const where = isLocalHost() ? '这台电脑' : '这个服务器';
        setGlobalStatus('notice', `链接里没有《${names}》：这是你自己上传的文本，只存在${where}上，别人打开链接时看不到。`
            + '想把完整结果分享出去，请用「更多导出 → 导出摘要」。');
    }
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
        return '分析只在本机进行，不上传服务器。';
    }
    return '文件会发到本服务器分析、未加密传输，请不要上传敏感或未获授权的文本。';
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
    // 忙时禁用 input 本身就够了：它既不可点也不在 Tab 序列里，
    // 屏幕阅读器读到的也是「不可用」。原来那句 aria-disabled 挂在 label 上，
    // 而 label 没有能承载它的角色，等于没用。
    if (fileInput) fileInput.disabled = isBusy;
    if (uploadBtn) uploadBtn.classList.toggle('is-busy', isBusy);
}

function getErrorMessage(response, result) {
    // 先认服务端给的 message，再管状态码。原来的顺序反了：413 一律被下面这句硬编码的
    // 「不能超过 50 MB」顶掉，而那个数字在线上是错的（nginx 在 20 MB 就拦），
    // 连服务端自己写好的解释也一并丢掉。走到兜底 413 只剩一种情况——请求根本没到应用，
    // 是 nginx 直接回的 HTML 错误页，那种响应里读不到 message。
    if (result && result.message) return result.message;
    if (response.status === 413) {
        return '文件太大，服务器不接受这么大的上传。请先截取要研究的章节，或拆成几个文件分次上传。';
    }
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
        // 可比时用的是与内置示例书共用的那套固定坐标范围（resolveGalaxyExtent 的
        // fixedExtent 分支），不随选书改变，所以只选一两本时点会挤在画布中间一小块。
        // 实测 1440 与 900 两种宽度下点云都只占到画布宽度的三成——这是设计，不是画坏了，
        // 但页面从来没说过，用户容易以为图出问题了。
        //
        // 条件必须卡在这里：独立模式（各书各自算，范围不共享）下这句话是假话，
        // 而且会和同一个面板上的「各书各自计算」告警直接打架；outOfRange 时范围已经
        // 被扩展过去容纳超界的数据，点也不再挤在中间，说了反而误导。
        if (extent && !extent.outOfRange) {
            lines.push('（坐标范围与内置示例书共用、不随选书改变，所以只选一两本时点会集中在中间一小块；这是正常的。）');
        }
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


// 吸顶的页签条挡在视口顶端，滚上去的内容标题会正正压在它底下，所以要先量它多高。
// 这个高度不是常量：窄屏（≤560px）改过字号和内边距，三个按钮 flex-wrap 换行后还会更高，
// 与其在 CSS 里写一个必然在某些宽度下遮住标题的 scroll-margin-top，不如每次实测。
function stickyTabsOffset() {
    const nav = document.querySelector('.tab-navigation');
    if (!nav) return 0;
    // +8：页签条底下还挂着 box-shadow(0 8px 14px -10px)，留一点缝免得标题贴着边
    return Math.ceil(nav.getBoundingClientRect().height) + 8;
}

// 元素在文档里的**布局**位置（offsetTop 逐级相加），不含 CSS transform。
// 这里不能用 getBoundingClientRect()：.view-section 每次显示都会重跑一遍
// fadeIn 动画（CSS `animation: fadeIn 0.4s`，from 状态是 translateY(10px)），
// 切页签的那一刻量到的是被动画挪下去 10px 的假位置，照着它滚就会多滚 10px——
// 正好把这行注释下面留的那点缝吃干净，标题还会压进吸顶条两像素。
// offsetTop 反映的是布局盒，动画在跑也不受影响。
function layoutOffsetTop(el) {
    let top = 0;
    for (let node = el; node; node = node.offsetParent) top += node.offsetTop;
    return top;
}

// 把某个视图的顶部滚到吸顶条下沿。用 window.scrollTo 而不是 scrollIntoView：
// 吸顶高度是动态的，反正都要实测，直接算 Y 更短、更显式，也能自己夹住顶部。
function scrollToSection(section) {
    if (!section) return;
    const top = layoutOffsetTop(section) - stickyTabsOffset();
    // behavior 必须显式传，而且必须自己问 prefersReducedMotion()：
    // JS 传进来的 behavior 会覆盖 CSS，CSS 里那条 scroll-behavior: auto !important
    // （prefers-reduced-motion 媒体查询下）保护不了这条路。
    window.scrollTo({
        top: Math.max(0, top),
        behavior: prefersReducedMotion() ? 'auto' : 'smooth'
    });
}

// Tab 切换逻辑
window.switchTab = function(tabId, options) {
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
        // 滚到刚切出来的这块内容。放在这里、不进下面的 setTimeout：
        // 视图顶部的 Y 只由它上面的内容决定（header/选书/上传/工具条都是固定高），
        // 图表渲染在视图内部、位于这个锚点之下，撑高多少都不移动它。
        // 上面压着约 630px 的工具区，不滚的话切了页签也看不见图。
        if (!options || options.scroll !== false) scrollToSection(activeSection);

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
        // 右侧详情卡里的数值是按上一个指标算出来的，图重画之后它就成了「另一张图上的数字」
        resetDetailPanelIfStale('换过观察角度');
        updateMetricHint();
        if (realData) {
            // 数据变化时，更新所有图表
            refreshAllActiveCharts();
        }
        // 面板空闲时那块「先看这 3 段」也是按指标算的，换指标必须跟着重算，
        // 否则它会停在上一套数字上（图已经换了，卡片没换——正是最容易被当成 bug 的那种）
        renderQuickPreviewIfIdle();
        syncUrlState();
    });

    // 平滑度调整。滑块拖动时 input 是连续触发的，而 initChart() 第一步就把
    // svg 里所有元素 remove 掉再整张重画（轴、网格、每本书的曲线、上百个数据点、
    // 图例），代价随「书数 × 片段数」增长——不节流的话拖一次要重画几十遍，
    // 表现就是拖不动、松手才跟上。
    // 用 rAF 合并成每帧最多画一次：取的是 module 级的 smoothness，永远是当前值，
    // 所以中途丢帧只是少画一次，不会画成旧值。URL 同步照旧每次 input 都做，
    // 免得标签页在后台时 rAF 不触发、分享链接停在半路的值上。
    let smoothnessFrame = null;
    document.getElementById('smoothness').addEventListener('input', function(e) {
        smoothness = parseInt(e.target.value);
        syncUrlState();
        if (!realData || smoothnessFrame) return;
        smoothnessFrame = requestAnimationFrame(() => {
            smoothnessFrame = null;
            initChart();
        });
    });

    // 导出图像 / 导出摘要 / 复制链接
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportChart);
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
    const copyConclusionBtn = document.getElementById('copyConclusionBtn');
    if (copyConclusionBtn) copyConclusionBtn.addEventListener('click', () => copyConclusion(copyConclusionBtn));
    // 「更多导出」是个纯显隐开关：四个低频按钮平时收在 #export-more 里（[hidden] 让它们
    // 连 Tab 都进不去），点一下就地展开。aria-expanded 是标准属性，读屏会念出「已展开/已折叠」。
    // 这里只翻这两个状态，**不碰按钮文字**：切到「收起导出」会让同一个控件的可访问名变来变去,
    // 而且用 textContent 整体重写会把箭头那个 span 一起删掉。箭头朝向交给 CSS 按 aria-expanded 转。
    const exportGroup = document.querySelector('.export-group');
    const exportMoreBtn = document.getElementById('exportMoreBtn');
    const exportMore = document.getElementById('export-more');
    if (exportGroup && exportMoreBtn && exportMore) {
        const setExportMore = function(open) {
            exportMore.hidden = !open;
            exportMoreBtn.setAttribute('aria-expanded', String(open));
        };

        exportMoreBtn.addEventListener('click', function() {
            setExportMore(exportMore.hidden);
        });

        // Escape 收起。监听挂在 .export-group 上而不是 document：keydown 只会从组内有焦点的
        // 子元素冒泡上来，「焦点在组内」这条前提是白拿的，所以结构上不可能抢走别处（星系弹窗）
        // 的同一个 Escape。收起必须显式把焦点还给切换钮——面板里的按钮会跟着一起 hidden，
        // 浏览器接着把焦点丢给 <body>，键盘用户当场丢位置。
        // 不写 preventDefault / stopPropagation：Escape 在这条路径上没有浏览器默认行为，
        // 拦下来只会让别的监听者收不到。
        exportGroup.addEventListener('keydown', function(e) {
            if (e.key !== 'Escape' || exportMore.hidden) return;
            setExportMore(false);
            exportMoreBtn.focus();
        });
    }

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
            // 不让 focus 参与滚动：focus() 默认会把元素滚进视口，而页签条是吸顶的、
            // 本来就在视口里，可它会在平滑滚动还在途中时把页面拽回去，两个偏移打架。
            // 滚动只归 switchTab 里的 scrollToSection 管。
            next.focus({ preventScroll: true });
        });
    });
}

// 挑出当前观察角度下「差别最明显的一对」：均值最小与最大的两本书。
//
// 候选优先只用内置示例书——与 getMetricContextLine 的参照基准同一条原则：
// 用户自己上传的书不该被拿来当基准。内置书不够两本，才退回全部已加载的书。
// 抽成函数是因为有两处要用：下面的「载入对比示例」按钮，以及首屏的默认选中。
function pickMostDifferentPair() {
    const candidates = (builtinBookNames.length > 0 ? builtinBookNames : Object.keys(realData || {}))
        .filter(name => getMetricValues(name, currentMetric).length > 0);
    if (candidates.length === 0) return [];
    if (candidates.length === 1) return [candidates[0]];

    const ranked = candidates
        .map(name => ({ name, mean: d3.mean(getMetricValues(name, currentMetric).map(d => d.value)) }))
        .filter(item => isFiniteNumber(item.mean))
        .sort((a, b) => a.mean - b.mean);
    return ranked.length > 1 ? [ranked[0].name, ranked[ranked.length - 1].name] : candidates.slice(0, 2);
}

// 「载入对比示例」：挑出在当前观察角度下差别最大的两本内置书
// （帮第一次来的用户一键看到「对比」长什么样，而不是自己盲选）
function loadComparisonExample() {
    if (!realData) {
        setUploadStatus('数据还在加载中，请稍等一下再试。', 'error');
        return;
    }

    const picks = pickMostDifferentPair();
    if (picks.length === 0) {
        setUploadStatus('暂时没有可用来做示例的书。', 'error');
        return;
    }

    selectedBooks = new Set(picks);
    syncBookButtonStates();
    updateMetricHint(); // 指标提示里那句「你选中的 N 本」要跟着选中数走，否则会停在初始的「1 本」
    resetDetailPanelIfStale('换过书');
    syncUrlState();
    renderQuickPreviewIfIdle(); // 面板里那块内容也要跟着换的书重算
    // 这个按钮的承诺是「看看这个工具能做什么」，而结论（一句话解读、值得一看的片段）
    // 都长在「全书对比」页上。原地点完之后用户还站在基础图表页，看到的还是同一张热力图，
    // 等于什么都没发生——所以直接把页签切过去（switchTab 自己会重画目标页，不必先白画一遍当前页）。
    window.switchTab('view-dashboard');
    setUploadStatus(
        `已选中《${picks.map(getBookDisplayName).join('》《')}》：它们的「${getMetricLabel(currentMetric)}」差别最大，适合先看差异。换「观察角度」可以再挑别的组合。`,
        'success'
    );
    // 上面那句写在上传区里，而这时候页面已经滚到「全书对比」页、上传区在屏幕外。
    showSelectionNotice('已切到「全书对比」页，这一页的几条结论是自动生成的。');
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
    setDemoEntryVisible(hidden);
}

// 「载入对比示例」的常驻入口长在「基础趋势分析」页的标题行里，和快速开始条互斥：
// 条子在的时候它多余，条子被 ✕ 收起之后它接班。
// 没有这一条，✕ 就等于把这个功能整个从界面上删掉了——它记在本机，换页面、换天也不会回来。
function setDemoEntryVisible(visible) {
    const entry = document.getElementById('demo-entry');
    if (entry) entry.hidden = !visible;
}

window.hideQuickStart = function() {
    const el = document.getElementById('quickstart');
    if (el) el.hidden = true;
    setDemoEntryVisible(true);
    try {
        window.localStorage.setItem(QUICKSTART_HIDDEN_KEY, '1');
    } catch (e) { /* 存不了就这次会话内收起 */ }
};

window.loadComparisonExample = loadComparisonExample;

// 根据当前图表类型控制「曲线平滑」的显隐：热力图是像素块，没有曲线可平滑。
//
// 「多书对比」那行提示曾经也一并藏起来，理由是「热力图不支持多书对比」——那是错的：
// drawMultiHeatmap 本来就按 booksArray 循环，每本书各占一列（列数 ceil(sqrt(n))，
// 可用宽度按书数均分），选 3 本会并排画出三张网格。也就是说那句「可多选对比」的提示
// 在热力图下同样为真，跟着藏起来等于把一句真话收走了。
// 它本身只是个 <div> 提示语（没有点击处理器），显不显示都不影响图表行为。
function updateChartTypeUI() {
    const smoothnessGroup = document.getElementById('smoothnessGroup');

    if (smoothnessGroup) {
        smoothnessGroup.style.display = chartType === 'heatmap' ? 'none' : 'flex';
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
            // 「只有这个浏览器能看到」必须说出来：书架是按浏览器里的一枚编号分开放的，
            // 不说的话，用户会以为别人也能看到、或者以为自己换个设备还找得回来。
            ? '已存入「我的图书馆」（只有这个浏览器能看到），刷新后仍在，可点书名旁 ✕ 删除。'
            : (result.warning ? '' : '本次未勾选保存，刷新后不会保留。');
        // 书名跟用户以为的不一致时，必须说出来。三种情况，后果完全不同：
        //   1) renamedFrom   —— 撞了内置示例书，存成了《X（我的）》，谁都没被覆盖；
        //   2) replacedExisting —— 同名旧书被这次的结果整份替换掉了，上一版没了；
        //   3) shadowsExisting  —— 这次没保存，但书名和书库里那本重名：屏幕上看到的是
        //                          新的，书库里留着的还是旧的，两个「同一本」不同内容。
        const newName = `《${getBookDisplayName(result.book)}》`;
        const notes = [];
        if (result.renamedFrom) {
            const oldName = `《${getBookDisplayName(result.renamedFrom)}》`;
            notes.push(result.saved
                ? `${oldName}是内置示例书的书名，这次存为${newName}，示例书不受影响。`
                : `${oldName}是内置示例书的书名，这次的分析以${newName}显示。`);
        }
        if (result.replacedExisting) {
            notes.push(`你书架上同名的${newName}已被这次的结果整份替换，上一版分析不再保留。`);
        } else if (result.shadowsExisting) {
            notes.push(`书名和你已保存的${newName}重名：屏幕上显示的是这次的分析结果，`
                + '书架里存着的仍是上次保存的那一份（这次未勾选保存）。');
        }
        if (result.warning) notes.push(result.warning);
        setUploadStatus(
            `「${getBookDisplayName(result.book)}」分析完成，共划分 ${nBlocks} 个片段。${savedMsg}${notes.join('')}`,
            result.warning ? 'error' : 'success'
        );
        updateMetricHint();
        refreshAllActiveCharts();
        renderQuickPreviewIfIdle(); // 新书进来后，面板空闲时也该有内容可点
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
//
// 第二十批起按书架编号分格存（{编号: {书名: 令牌}}）：认领过别人的编号之后，
// 两格书架上可能有同名的书而令牌不同，平铺存会拿错令牌（服务端 403，且无法自愈）。
// 旧数据是平铺的 {书名: 令牌}，拿到编号时就地搬进这一格（见 setShelfCode）。
const DELETE_TOKEN_KEY = 'wenxin.deleteTokens';

// 当前浏览器的书架编号，由 /api/books 的 shelfCode 现给（cookie 是 HttpOnly，
// JS 读不到）。接口没回来之前是空串。
let currentShelfCode = '';

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

// 这一格书架的令牌桶；还没有桶（或还不知道编号）时返回 null，调用方按旧版平铺表兜底
function shelfTokenBucket(tokens) {
    if (!currentShelfCode) return null;
    const bucket = tokens[currentShelfCode];
    return bucket && typeof bucket === 'object' ? bucket : null;
}

// 记下编号，并把旧版平铺表搬进这一格。幂等：搬完顶层就只剩编号键了。
// 不搬的话，升级后老浏览器里那些书的 ✕ 会突然全变 403——令牌一直都在，
// 只是没人再找得到它。
function setShelfCode(code) {
    currentShelfCode = typeof code === 'string' ? code : '';
    if (!currentShelfCode) return;
    const tokens = readDeleteTokens();
    const legacyKeys = Object.keys(tokens).filter(k => typeof tokens[k] === 'string');
    if (legacyKeys.length === 0) return;
    const bucket = shelfTokenBucket(tokens) || {};
    legacyKeys.forEach(k => {
        bucket[k] = tokens[k];
        delete tokens[k];
    });
    tokens[currentShelfCode] = bucket;
    writeDeleteTokens(tokens);
}

function rememberDeleteToken(bookName, token) {
    if (!bookName || !token) return;
    const tokens = readDeleteTokens();
    if (!currentShelfCode) {
        tokens[bookName] = token; // 还不知道编号（接口失败等），按住旧版平铺表写
        writeDeleteTokens(tokens);
        return;
    }
    const bucket = shelfTokenBucket(tokens) || {};
    bucket[bookName] = token;
    tokens[currentShelfCode] = bucket;
    writeDeleteTokens(tokens);
}

function forgetDeleteToken(bookName) {
    const tokens = readDeleteTokens();
    const bucket = shelfTokenBucket(tokens);
    let changed = false;
    if (bucket && bookName in bucket) { delete bucket[bookName]; changed = true; }
    if (typeof tokens[bookName] === 'string') { delete tokens[bookName]; changed = true; }
    if (changed) writeDeleteTokens(tokens);
}

function getDeleteToken(bookName) {
    const tokens = readDeleteTokens();
    const bucket = shelfTokenBucket(tokens);
    if (bucket && bookName in bucket) return bucket[bookName] || '';
    const legacy = tokens[bookName]; // 旧版平铺表（还没搬过、或编号未知时）
    return typeof legacy === 'string' ? legacy : '';
}

// 认领书架成功后，把服务端交回的令牌一次写进那一格（整格替换，避免和旧桶混在一起）
function seedDeleteTokens(code, books) {
    if (!code || !Array.isArray(books)) return;
    const tokens = readDeleteTokens();
    const bucket = {};
    books.forEach(item => {
        if (item && item.name && item.deleteToken) bucket[item.name] = item.deleteToken;
    });
    tokens[code] = bucket;
    writeDeleteTokens(tokens);
}

// ---------------------------------------------------------------------------
// 「书架编号」弹窗：显示自己的编号（可复制）+ 在另一台设备上填另一枚编号切过去
//
// 编号是 HttpOnly cookie，页面本来读不到，靠 /api/books 的 shelfCode 现给。
// 切换成功之后要整页刷新：realData 是「合并」语义（loadRealData 不删旧键），
// 重跑一遍加载清不掉上一格书架的书。刷新前先把链接里的 books 参数摘掉，
// 否则会撞上「链接里的这 N 本书在这台服务器上找不到」那句假警报。
// ---------------------------------------------------------------------------
function openShelfModal() {
    const modal = document.getElementById('shelf-modal');
    if (!modal) return;
    const valueEl = document.getElementById('shelf-code-value');
    if (valueEl) valueEl.textContent = currentShelfCode || '（还没拿到，请刷新页面）';
    const status = document.getElementById('shelf-modal-status');
    if (status) {
        status.textContent = '';
        status.classList.remove('error');
    }
    const input = document.getElementById('shelf-code-input');
    if (input) input.value = '';

    modal.setAttribute('aria-hidden', 'false');
    modal.style.display = 'flex';
    document.addEventListener('keydown', trapShelfModalFocus);
    setTimeout(() => {
        modal.classList.add('show');
        const closeButton = modal.querySelector('.galaxy-modal-close');
        if (closeButton) closeButton.focus();
    }, 10);
}

function closeShelfModal() {
    const modal = document.getElementById('shelf-modal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', trapShelfModalFocus);
    setTimeout(() => {
        modal.style.display = 'none';
        const trigger = document.getElementById('shelf-code-btn');
        if (trigger) trigger.focus(); // 焦点还给打开它的那个按钮，不然键盘用户会掉到页面开头
    }, 300);
}

// 「切换到这个书架」：把编号交给服务端换发 cookie，回来后整页刷新
async function claimShelfCode() {
    const input = document.getElementById('shelf-code-input');
    const status = document.getElementById('shelf-modal-status');
    const btn = document.getElementById('shelf-code-claim');
    const code = ((input && input.value) || '').trim();
    if (!code) {
        if (status) {
            status.textContent = '请先输入另一台设备上的书架编号。';
            status.classList.add('error');
        }
        return;
    }
    if (btn) btn.disabled = true;
    try {
        const resp = await fetch(`${API_BASE_URL}/api/shelf/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shelf-Claim': '1' },
            body: JSON.stringify({ code }),
        });
        const contentType = resp.headers.get('content-type') || '';
        const result = contentType.includes('application/json') ? await resp.json() : null;
        if (!resp.ok || !result || result.status !== 'success') {
            if (status) {
                status.textContent = getErrorMessage(resp, result);
                status.classList.add('error');
            }
            return;
        }
        // 先落牌：令牌跟这一格走，刷新后 ✕ 才认得出你
        seedDeleteTokens(result.shelfCode, result.books);
        stripBooksFromUrl();
        if (status) {
            status.textContent = '已切换，正在重新加载…';
            status.classList.remove('error');
        }
        window.location.reload();
    } catch (e) {
        console.error('切换书架失败:', e);
        if (status) {
            status.textContent = '无法连接分析服务，请稍后重试。';
            status.classList.add('error');
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

// 摘掉链接里的 books 参数（其余参数照旧），供切书架后刷新用
function stripBooksFromUrl() {
    try {
        const params = new URLSearchParams(window.location.search);
        if (!params.has('books')) return;
        params.delete('books');
        const query = params.toString();
        window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash);
    } catch (e) { /* 改不了也照常刷新：最坏是刷新后多一句「链接里的书找不到」 */ }
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
        // 删掉的如果是面板里正列着的那本书，那块内容必须跟着换（或换成打回态）
        renderQuickPreviewIfIdle();
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
    // 这一句必须排在 fetch 前面。服务端 /api/books 里带着 _ensure_demo_data()，
    // 全新部署的第一次请求要现场生成示例数据（api_server.py 自己的注释：重算要跑 1~3 分钟），
    // 而这期间屏幕上原来一个字都没有——首屏看上去就是坏的。加载提示不能等第一个 await 回来。
    showLoading('正在加载书籍列表…');
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
        // 记下这个浏览器的书架编号（服务端现给，cookie 是 HttpOnly 读不到）。
        // 「书架编号」弹窗靠它显示，删除令牌的存放也按它分格。
        setShelfCode(data.shelfCode);
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
    }
    // 没有链接参数时不在这里选书：首屏默认选的是「差别最明显的两本」，而那要等
    // 数据到手才算得出来（见 loadRealData）。这里先如实空着——原来那句
    // selectBook(books[0].id) 选的是未排序 glob 出来的「第一本」，本来就没有
    // 确定含义，而且紧接着又会被数据到手后的默认值换掉，白画一遍图。
}

// 一次性的页面提示。故意挂在 body 直下：.container 有 backdrop-filter，会成为
// fixed 后代的包含块，挂进容器里 bottom:28px 会被当成「距容器底部 28px」——
// 容器的两千多像素高意味着提示落在屏幕外（详情弹窗踩的正是这个坑）。
// 默认 3.4 秒后自己淡出；重复调用只换文字、重置计时，不会叠出第二条。
// options.announce === false：同一个字符串如果已经由顶部状态条（role="status"）念过一遍，
//   这里就把自己从 live region 里摘出去，读屏不会连读两遍——条子本身照样看得见。
//   元素是复用的，所以两种状态都要显式写回去，不能只在创建时设一次。
// options.duration：错误那句话比「至少要留一本书」长得多，默认 3.4 秒读不完。
let selectionNoticeTimer = null;
function showSelectionNotice(text, options) {
    let el = document.getElementById('selection-notice');
    if (!el) {
        el = document.createElement('div');
        el.id = 'selection-notice';
        el.className = 'selection-notice';
        document.body.appendChild(el);
    }
    if (options && options.announce === false) {
        el.removeAttribute('role');
        el.removeAttribute('aria-live');
    } else {
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
    }
    el.textContent = text;
    el.classList.add('show');
    if (selectionNoticeTimer) clearTimeout(selectionNoticeTimer);
    selectionNoticeTimer = setTimeout(() => el.classList.remove('show'), (options && options.duration) || 3400);
}

function selectBook(bookId) {
    const btn = getBookButtonById(bookId);

    if (selectedBooks.has(bookId)) {
        if (selectedBooks.size <= 1) {
            // 至少要留一本书，否则三个页签都没有东西可画。原来这里直接静默返回，
            // 用户点了没反应、只能以为坏了；现在把原因说出来。
            showSelectionNotice('至少要留一本书在图上。想换书，先选另一本，再取消这一本。');
            return;
        }
        selectedBooks.delete(bookId);
        if (btn) btn.classList.remove('active');
    } else {
        // 如果未选中，则添加
        selectedBooks.add(bookId);
        if (btn) btn.classList.add('active');
    }

    updateCompareButtonLabel();
    // 指标提示里有「你选中的 N 本在 X – X 之间」，选书一变就得跟着重算
    updateMetricHint();
    // 卡片里那个点可能刚被取消掉了（或者它所属的书已经不在这张图上）
    resetDetailPanelIfStale('换过书');

    // 刷新当前可见的图表
    if (realData) {
        refreshAllActiveCharts();
    }
    // 面板空闲时那块「先看这 3 段」是按书 + 指标算的，选书一变就得重算
    renderQuickPreviewIfIdle();
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

        // 必须「合并」而不是整份替换：首次加载慢的时候（示例数据生成约 1–2 分钟，
        // 或线上冷启动），用户可能先传完一本书——上传写在 realData[book] 上，
        // 这里一替换就把它冲掉了，界面上表现为「刚传的书不见了」，还会误报
        // 「链接里的这本书找不到」。合并即可，后到的示例书照样进得来。
        // （loadRealData 全站只在页面初始化时调用一次，不存在需要清掉旧键的场景。）
        const incoming = data.data && typeof data.data === 'object' ? data.data : {};
        realData = Object.assign(realData || {}, incoming);
        const availableBooks = Object.keys(realData);
        if (availableBooks.length === 0) {
            showNoDataMessage();
            return;
        }
        // 顶部状态条照旧报一句成功（6 秒后自己收起）。以前这里还往右侧面板里写一张
        // 「成功」状态卡，一直挂到用户点某个格子为止；现在那块地方留给
        // renderQuickPreviewIfIdle 的「先看这 3 段」（见本函数末尾）。
        // 位置不能挪到下面：链接里点名的书丢了时，那句 notice 必须压过这句。
        setGlobalStatus('success', `成功加载 ${availableBooks.length} 本书籍的数据`);
        updateMetricHint(); // 参考区间跟随当前已加载书集合
        renderAxisWordHints(); // 轴词说明也跟随已加载的书（用户可能还没切到星系页）

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
            // 首屏默认：差别最明显的两本内置书（第一次来的用户打开就能看到「对比」
            // 长什么样，而不是对着一张单书热力图猜这个工具能干什么）。
            // 只在这一次定：之后选书、换指标都跟着用户走，不再重挑。
            const picks = pickMostDifferentPair();
            if (picks.length > 0) {
                // 一次性把整个集合换上，不走两次 selectBook——那会白画两遍图。
                selectedBooks = new Set(picks);
                syncBookButtonStates();
                updateMetricHint(); // 上面那次算的是空集合，这里要跟着新的选中数重算
                syncUrlState();
                refreshAllActiveCharts();
                // 选中两本必须是「说明过的」：不说一句，用户打开就看到两张并排的图，
                // 不知道这两本是谁挑的、凭什么。只在自动挑书这一次说（带书籍链接进来、
                // 或者自己选过书之后都不会走到这个分支）。
                showSelectionNotice(
                    `已替你选中差别最大的两本：《${picks.map(getBookDisplayName).join('》《')}》——`
                    + `它们的「${getMetricLabel(currentMetric)}」差得最远。`,
                    { duration: 6000 }
                );
            } else {
                selectBook(availableBooks[0]); // 兜底：连一对都挑不出来时，照旧选第一本
            }
        } else {
            syncBookButtonStates(); // 链接还原 / 书籍变动后，把选中态落到按钮上
            refreshAllActiveCharts();
        }
        // 右侧面板不再只剩一句「成功加载 N 本书籍的数据」——首屏就给出能点进去看的内容
        renderQuickPreviewIfIdle();
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
    const margin = { top: 40, right: 120, bottom: 50, left: 60 };
    const width = containerWidth - margin.left - margin.right;
    // 绘图区高度固定 310（也就是原来写死的 400 减去上下留白），书多书少曲线形状一致。
    // 但画布本身要按右侧图例的行数撑高：图例一本一行、行距 25px 从 margin.top 往下堆，
    // 原先高度写死 400，超过 (400-40)/25 ≈ 14 本，后面的书就掉到 viewBox 外面——
    // 图上有那条线，图例里却找不到它叫什么。热力图早就按内容撑高了
    // （见 drawMultiHeatmap 的 totalHeight），折线图这里是漏的。
    // 只长画布、不长绘图区：否则书一多，同一条曲线会被拉得比书少时陡。
    const plotHeight = 400 - margin.top - margin.bottom;
    const legendRowHeight = 25;
    const height = Math.max(400, margin.top + chartData.length * legendRowHeight + margin.bottom);

    // 热力图会按书的数量把 svg 撑高（见 drawMultiHeatmap 的 style("height")），
    // 折线图必须把高度写回来：initChart 的 selectAll("*").remove() 只删子节点，
    // 清不掉 inline 高度。少了这一句，书少时（含默认的单本）折线图会缩在
    // 上一次热力图留下的高盒子里，导出 PNG 也跟着大半张空白。
    svg.attr("viewBox", `0 0 ${containerWidth} ${height}`)
       .style("height", height + "px");
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const maxBlocks = d3.max(chartData, d => d.values.length - 1);
    const allValues = chartData.flatMap(d => d.values.map(v => v.value));
    const extent = d3.extent(allValues);
    // 上下界用「加法 padding」，不能用乘法。乘法对负区间方向是反的：
    // 区间全负时 extent[0]*0.95 反而把下界往上抬、extent[1]*1.05 把上界往下压，
    // 可视窗口比数据本身还窄。「风格走向」是 PCA 有符号值，默认那本（哈克贝利·费恩，
    // 102 个片段）实测全负 -0.0597 ~ -0.0169，于是 12 个片段被画到 x 轴下方、
    // 最高的那个点跑到图标题区。注意符号是逐本不同的：另外三本都有正值，
    // 四本合起来是 -0.0597 ~ +0.0675，所以边界逻辑不能假设「一定全负」。
    // 改成按本跨度往两边撑，正区间负区间都是「往外」。
    const span = extent[1] - extent[0];
    const pad = (isFiniteNumber(span) && span > 0) ? span * 0.05 : 1;
    let yMin = extent[0] - pad;
    let yMax = extent[1] + pad;
    if (!isFiniteNumber(yMin) || !isFiniteNumber(yMax) || yMin === yMax) {
        const center = isFiniteNumber(extent[0]) ? extent[0] : 0;
        yMin = center - 1;
        yMax = center + 1;
    }

    const xScale = d3.scaleLinear().domain([0, maxBlocks]).range([0, width]);
    const yScale = d3.scaleLinear().domain([yMin, yMax]).range([plotHeight, 0]);

    // 取色统一走 colorForBook（按全库顺序，不按点选顺序），
    // 否则同一本书在这张图和「全书对比」页会是两个颜色

    g.append("g").attr("transform", `translate(0,${plotHeight})`).call(d3.axisBottom(xScale));
    g.append("g").call(d3.axisLeft(yScale));
    
    g.append("g").attr("class", "grid").call(d3.axisLeft(yScale).tickSize(-width).tickFormat("")).attr("stroke-opacity", 0.1);

    // 坐标轴标签：X 为「第几个片段」，Y 为当前指标中文名。
    // X 轴不能叫「阅读进度」：xScale 的 domain 是 [0, maxBlocks]，每本书按**自己的**
    // 片段序号（d3.line 里 .x((d, i) => xScale(i))）画，而各书片段总数差很多
    // （野性的呼唤 22 个、哈克贝利·费恩 102 个，4.6 倍）。同一个 x 在两本书里对应的
    // 阅读位置完全不同，第 50 个片段在 22 个片段的书里根本不存在——「阅读进度」会让人
    // 把两条线在同一 x 上直接对比，读出不存在的结论。说成百分比也是错的，因为这里
    // 没有做任何归一化。（看板页的走势图才是归一化到 0–100% 的，那里才叫阅读进度。）
    ["片段序号（每个片段约 1 万个单词）", "各书片段总数不同，同一个序号不代表相同的阅读位置"]
        .forEach((line, i) => {
            g.append("text")
                .attr("class", "axis-label")
                .attr("x", width / 2)
                .attr("y", plotHeight + 38 + i * 14)
                .attr("text-anchor", "middle")
                .text(line);
        });

    g.append("text")
        .attr("class", "axis-label")
        .attr("transform", "rotate(-90)")
        .attr("x", -plotHeight / 2)
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
            .attr("stroke", colorForBook(bookData.book))
            .attr("stroke-width", 2.5)
            .attr("stroke-dasharray", dashForBook(bookData.book))
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
            .attr("fill", colorForBook(bookData.book))
            .attr("stroke", "#fdfaf3")
            .attr("stroke-width", 1.5)
            .attr("role", "button")
            .attr("aria-label", d => `${getBookDisplayName(bookData.book)} 第 ${d.block + 1} 个片段，${getMetricLabel(currentMetric)} ${formatMetric(d.value)}`)
            .style("cursor", "pointer")
            .style("opacity", 0) 
            .on("mouseover", function(event, d) {
                d3.select(this)
                    .style("opacity", 1)
                    .transition().duration(motionDuration(100))
                    .attr("r", 6)
                    .attr("stroke", "#b5472f")
                    .attr("stroke-width", 2);
                
                showTooltip(event, d, bookData.book);
            })
            .on("mouseout", function(event, d) {
                d3.select(this)
                    .transition().duration(motionDuration(200))
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
                    return;
                }
                // ← → 沿片段顺序移动焦点，Home / End 跳首尾。
                // 走法和热力图那套一致：进来只占一个 Tab 停靠点，之后用方向键逐点走。
                const all = g.selectAll(`.point-${safeBookID}`).nodes();
                const current = all.indexOf(this);
                let next = null;
                if (event.key === 'ArrowRight') next = current + 1;
                else if (event.key === 'ArrowLeft') next = current - 1;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = all.length - 1;
                if (next === null) return;
                event.preventDefault();
                if (next < 0 || next >= all.length) return;
                all.forEach(node => node.setAttribute('tabindex', '-1'));
                all[next].setAttribute('tabindex', '0');
                all[next].focus();
            });

        // 一本书上百个点，如果每个都能 Tab 到，键盘用户要按上百次才走得出去；
        // 所以整条折线只留一个 Tab 停靠点（第一个点），其余靠上面的方向键。
        g.selectAll(`.point-${safeBookID}`).attr("tabindex", (d, i) => (i === 0 ? 0 : -1));
    });

    const legend = svg.append("g").attr("transform", `translate(${width + 20}, ${margin.top})`);
    chartData.forEach((d, i) => {
        const row = legend.append("g").attr("transform", `translate(0, ${i * legendRowHeight})`);
        // 图例里画的是**线**而不是色块：这是折线图的图例，把每本书的线型一并画出来，
        // 只靠颜色分不出来的读者才能把图上的线和这里的书名对上。色块形状留给
        // 热力图与星系那两处（它们的图元本来就不是线）。
        row.append("line")
            .attr("x1", 0).attr("x2", 16)
            .attr("y1", 7.5).attr("y2", 7.5)
            .attr("stroke", colorForBook(d.book))
            .attr("stroke-width", 2.5)
            .attr("stroke-dasharray", dashForBook(d.book));
        row.append("text").attr("x", 22).attr("y", 12).text(getBookDisplayName(d.book)).style("font-size", "12px").style("fill", "#5c5346");
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

// 热力图色阶：蓝（低）— 米（中）— 红（高）。
// 只拉明暗、不动色相。原来两端是 #2c4a6e / #a0221a，相对亮度 0.066 / 0.087，
// 两端对比只有 1.18:1——深蓝块和深红块在红绿色盲眼里是同一档，分不出高低；
// 中段的 #f2e7cd 又和卡片底差 1.17:1，取值接近中位数的格子看着像「没有数据」。
// 现在两端拉到 3.19:1（ΔL 0.258），中段改用 --elev 的米色。
const HEATMAP_LOW = '#7f9dc4';
const HEATMAP_MID = '#ece0c3';
const HEATMAP_HIGH = '#8f1d16';
// 格子描边：中段米色与卡片底仍接近，靠描边把网格画出来
const HEATMAP_STROKE = '#cbb894';
// 图例两端「低 / 高」那两个字用的墨色。色阶本身要拉明暗，但文字得够黑才读得清
// （AA 正文 4.5:1）：浅蓝 #7f9dc4 当文字只有 2.66:1，所以文字仍用深色，
// 浅色只出现在它旁边那条渐变色条上。
const HEATMAP_LOW_INK = '#2c4a6e';
const HEATMAP_HIGH_INK = '#8f1d16';

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

    // 每本书的格子边长是各算各的（取决于它自己的 cols），所以画布高度必须按
    // 「每一本自己的 rows × blockSize」取最大值。旧写法拿第一本的 blockSize 去乘
    // 全局最大行数：只要后面某本书的格子比第一本大，它的网格就会伸进下边距，
    // 图例条和「虚线是章节分界」那行说明正好压在最后一排格子上。
    let maxGridHeight = 0;

    chartData.forEach(bookData => {
        const n = bookData.values.length;
        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        const blockSize = Math.max(1, Math.floor(chartWidth / cols));

        maxGridHeight = Math.max(maxGridHeight, rows * blockSize);
    });

    const totalHeight = Math.max(400, topMargin + maxGridHeight + bottomMargin);

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
        .interpolator(d3.piecewise(d3.interpolateRgb, [HEATMAP_LOW, HEATMAP_MID, HEATMAP_HIGH]))
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
                d3.select(this).style("stroke", HEATMAP_STROKE).style("stroke-width", "1px");
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
    const legendH = 12;

    // 先把两端的标签建出来量宽度：色带宽度原来是写死的 220，两个标签又各贴着色带
    // 往外排 10px，于是在 320px 宽的屏幕上，左端渲染出来只剩「短句」——「低 · 」整个
    // 被裁在画布外，读者只看到色带的右端有「高」，左端是什么就没了对照；换成
    // 「独特词丰富度」这种四个字以上的指标，390px 的 iPhone 也一样中招。
    // 导出的 PNG 走的是同一个 viewBox，残缺的图例会一起被导出。
    const lowText = svg.append("text")
        .style("font-size", "12px")
        .style("fill", HEATMAP_LOW_INK)
        .style("font-weight", "bold")
        .text(`低 · ${lowLabel}`);
    const highText = svg.append("text")
        .style("font-size", "12px")
        .style("fill", HEATMAP_HIGH_INK)
        .style("font-weight", "bold")
        .text(`高 · ${highLabel}`);

    const LEGEND_GAP = 10;
    const LEGEND_SIDE = 8;
    const MIN_BAR = 60;
    const avail = containerWidth - LEGEND_SIDE * 2;
    const lowW = lowText.node().getComputedTextLength();
    const highW = highText.node().getComputedTextLength();
    // 色带至少留 MIN_BAR 才看得出渐变；连这个都放不下就把两个标签挪到色带下面一行，
    // 左对齐 + 右对齐分开写。宁可多占一行，也不能把「低」那一端裁掉。
    const stacked = lowW + highW + LEGEND_GAP * 4 + MIN_BAR > avail;

    let legendW, legendX, legendY, labelY;
    if (stacked) {
        legendW = Math.max(MIN_BAR, Math.min(220, avail - LEGEND_GAP * 2));
        legendX = (containerWidth - legendW) / 2;
        legendY = totalHeight - 58;
        labelY = legendY + legendH + 15;
        lowText.attr("x", LEGEND_SIDE).attr("y", labelY).attr("text-anchor", "start");
        highText.attr("x", containerWidth - LEGEND_SIDE).attr("y", labelY).attr("text-anchor", "end");
    } else {
        legendW = Math.max(MIN_BAR, Math.min(220, avail - lowW - highW - LEGEND_GAP * 4));
        legendX = (containerWidth - legendW) / 2;
        legendY = totalHeight - 46;
        labelY = legendY + legendH / 2 + 4;
        lowText.attr("x", legendX - LEGEND_GAP).attr("y", labelY).attr("text-anchor", "end");
        highText.attr("x", legendX + legendW + LEGEND_GAP).attr("y", labelY).attr("text-anchor", "start");
    }

    const legendGrad = svg.append("defs").append("linearGradient")
        .attr("id", "heatmapLegendGrad")
        .attr("x1", "0%").attr("x2", "100%");
    legendGrad.append("stop").attr("offset", "0%").attr("stop-color", HEATMAP_LOW);
    legendGrad.append("stop").attr("offset", "50%").attr("stop-color", HEATMAP_MID);
    legendGrad.append("stop").attr("offset", "100%").attr("stop-color", HEATMAP_HIGH);

    svg.append("rect")
        .attr("x", legendX).attr("y", legendY)
        .attr("width", legendW).attr("height", legendH)
        .attr("rx", 3)
        .attr("fill", "url(#heatmapLegendGrad)")
        .attr("stroke", HEATMAP_STROKE)
        .attr("stroke-width", 1);

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

// 提示框全程只建一个，反复复用。以前每次悬停都新建一个 div、量一次
// getBoundingClientRect——读几何量会强制同步布局（reflow）——hideTooltip 再把它删掉，
// 下一次又重新建。鼠标扫过折线或热力图时每秒几十次，这是最容易被漏掉的一处「用起来卡」。
// 元素留在 DOM 里不删：.tooltip 在 CSS 里已经是 pointer-events:none，
// 一个透明但仍存在的提示框不会挡住下面的图。
let tooltipEl = null;

function showTooltip(event, data, bookName) {
    if (!tooltipEl) {
        tooltipEl = d3.select("body").append("div")
            .attr("class", "tooltip")
            .style("opacity", 0)
            .style("left", "0px")
            .style("top", "0px");
    }
    const tooltip = tooltipEl;
    // 上一次的淡出可能还没走完（hideTooltip 现在不删节点）。先掐断它、把透明度拨回 0
    // 再重新淡入，否则新内容会从「正在淡出的那个中间值」接着往上走，闪一下。
    tooltip.interrupt().style("opacity", 0);

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
            <strong>${escapeHtml(getMetricLabel(currentMetric))}:</strong> ${escapeHtml(formatMetric(data.value))}
        </div>
        ${keywords ? `<div style="margin-top: 5px;"><strong>关键词:</strong> <span lang="en">${keywords}</span></div>` : ''}
    `);

    // 定位：先按鼠标右下角摆，量出真实尺寸后按视口夹紧。
    // 旧写法只写 left: pageX+10，而绝对定位元素的宽度由「容器剩余宽度」决定——
    // 窄屏上靠近右缘的格子会把提示框挤成一根 70px 宽、327px 高的竖条（一次只显示
    // 一个字）。改用 fixed + clientX/clientY，既不受滚动影响，也能把框推回屏幕内。
    const box = tooltip.node().getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = event.clientX + 12;
    let top = event.clientY - 10;
    if (left + box.width > vw - 8) left = Math.max(8, vw - box.width - 8);
    if (top + box.height > vh - 8) top = Math.max(8, vh - box.height - 8);
    if (top < 8) top = 8;

    tooltip.style("position", "fixed")
        .style("left", left + "px")
        .style("top", top + "px")
        .transition()
        .duration(motionDuration(200))
        .style("opacity", 1);
}

function hideTooltip() {
    if (!tooltipEl) return;
    // 只淡出、不删节点——删了下次还得重建。CSS 里 .tooltip 是 pointer-events:none，
    // 所以留一个透明的提示框在页面上不会挡到任何交互。
    tooltipEl.interrupt()
        .transition()
        .duration(motionDuration(200))
        .style("opacity", 0);
}

// 右侧面板的「空闲内容」：第一本选中书里，当前指标最突出的 3 段。
//
// 这块地方原先在数据加载完之后只剩一句「成功加载 N 本书籍的数据」，一直挂到用户
// 点某个格子为止——首屏最贵的一块地只放了一句状态话。现在换成能直接点进去的内容：
// 点一行 = 点图上那个格子（同一个 showDetail，不新建第二条详情路径）。
//
// 只在面板「空闲」时渲染（没有 .block-location = 用户没有正在看某一段）：
// 用户点过格子之后，任何自动内容都不许盖掉它——点击永远优先。所以它是「调用一下、
// 自己判断」，而不是塞进 refreshAllActiveCharts（那条路径还被窗口 resize 与
// 「重置视图」调用，既没必要，还可能打断键盘操作）。
function renderQuickPreviewIfIdle() {
    const detailPanel = document.getElementById('detailPanel');
    if (!detailPanel || !realData) return;
    if (detailPanel.querySelector('.block-location')) return; // 用户正在看某一段，不打扰

    // 只列「第一本选中书」：面板只有一列，两本并排列会变成一份没有人要的清单。
    // 选它自己的书（而不是硬取 availableBooks[0]）——用户换书后，这里跟着换。
    const book = Array.from(selectedBooks).find(name => getMetricValues(name, currentMetric).length > 0);
    const top = book
        ? getMetricValues(book, currentMetric).slice().sort((a, b) => b.value - a.value).slice(0, 3)
        : [];
    if (top.length === 0) {
        // 算不出内容时，面板上剩下的东西必须说得清「为什么没有」——不能留上一本书那 3 行
        // （点开会弹出一本已经删掉/换掉的书），更不能留着那张「正在加载」的卡：
        // loadRealData 先写它、末尾再调这里，这里一早退就没人回来关，它会一直转到刷新为止
        // （比如 URL 带了 ?metric= 而选中的书没有这个指标）。
        // 只收拾自己写过的两块（3 行清单 / 加载卡），用户点开的详情卡上面已经放行过了。
        if (detailPanel.querySelector('.state-card.loading') || detailPanel.querySelector('.quick-preview')) {
            showNoDataMessage('选中的书在当前「观察角度」下没有可展示的片段，换一个观察角度或再选一本书试试。');
        }
        return;
    }

    const loaded = Object.keys(realData).length;
    const selectedCount = selectedBooks.size;
    const rows = top.map(d => `
            <button type="button" class="quick-preview-row" data-block="${escapeHtml(String(d.block))}">
                <span class="qp-value">${escapeHtml(formatMetric(d.value))}</span>
                <span class="qp-loc">${escapeHtml(formatBlockLocation(book, d.block))}</span>
            </button>`).join('');

    detailPanel.innerHTML = `
        <h3>▤ 数据详情</h3>
        <p>已加载 ${loaded} 本书${selectedCount > 1 ? `，图上选中 ${selectedCount} 本` : ''}。
           先看《${escapeHtml(getBookDisplayName(book))}》里「${escapeHtml(getMetricLabel(currentMetric))}」最突出的 3 段：</p>
        <div class="quick-preview" data-book-id="${escapeHtml(book)}">
            ${rows}
        </div>
        <p class="excerpt-note">点上面任意一行，和点图上那个格子是一回事。</p>
    `;
    detailPanel.querySelectorAll('.quick-preview-row').forEach((btn, i) => {
        btn.addEventListener('click', () => showDetail(top[i], book));
    });
}

function showDetail(data, bookName) {
    const detailPanel = document.getElementById('detailPanel');
    if (!detailPanel) return;

    const displayName = getBookDisplayName(bookName);
    const keywordsHtml = Array.isArray(data.keywords) && data.keywords.length > 0
        ? data.keywords.map(keyword => `<span class="keyword-tag" lang="en">${escapeHtml(keyword)}</span>`).join('')
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
    // 引号里显示的和按钮复制到的是两段不同长度的文本（露 150 字、复制 1200 字）。
    // 这不是错，但不能不说：加一行小字说明复制到的是多长，按钮上也带字数。
    const previewHtml = data.preview ? `
            <div>
                <h4>📄 原文片段</h4>
                <p lang="en" style="margin-top: 10px; color: #6b6254; font-style: italic;">
                    "${escapeHtml(data.preview)}"
                </p>
                ${sourceText ? `<p class="excerpt-note">以上为片段开头的引文；复制得到的是更长的摘录，仍非全文（一个片段约 1 万词）。</p>` : ''}
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
        hapaxLegomena: '由「总词数、不同词的个数、只出现过一次的词数」综合算出。它通常不是 0–1 的比例，也不是百分比——数值越大，一般说明用词越丰富、越不单调。这个数已经按篇幅折算过，长短不同的书也能比。',
        functionWords: `不看内容，而看高频小词${getAxisWordsHint()}的使用习惯。点越靠近只说明这些词的用法越像，不等于两本书本身相似。`
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
//
// 这个注册表原先只 push、从不清空，也没有上限：同一段摘录每重绘一次就再追加一条
// （看板的悬停预览、排序、框选、换指标都会重绘；点开片段详情也会），页面开着越久
// 数组越大，而摘录本身有 1200 字符。
// 现在按文本去重：同一段文字复用同一个下标，重复注册不再增长。
// 注意**不能**改成「满了就清空」——按钮上带的是下标，清空会让已经渲染出去的按钮
// 指到别人身上。去重表只增不减，所以任何时刻的旧按钮都仍然指向它当初那段原文。
// 不同摘录的数量天然有上限（一本书的片段数），所以不设人为的条数上限。
const _copySources = [];
const _copySourceIndex = new Map();

function registerCopySource(text) {
    const key = String(text ?? '');
    const known = _copySourceIndex.get(key);
    if (known !== undefined) return known;
    const idx = _copySources.push(key) - 1;
    _copySourceIndex.set(key, idx);
    return idx;
}

// 「这段摘录有多少字」只有一个算法，两处（卡片按钮、原文弹窗）都从这里取。
// 以前两处各算各的：卡片把 _preview() 补的那三个省略号减掉再数，弹窗直接数原始长度，
// 于是同一段文本，卡片写「1200 字」、弹窗写「1203 字符」——数字差 3、单位还不一样，
// 摆在同一屏上像两个数在打架。统一成：**只数真正复制到的正文字符**（省略号是界面加的，
// 不是原文），单位用「字符」——正文是英文，说「字」本来就不准。
function excerptCharCount(text) {
    const src = String(text ?? '');
    return src.endsWith('...') ? src.length - 3 : src.length;
}

// 按钮上原先只写「复制片段」。可复制到的从来不是整个片段（那有 1 万词），而是开头
// 一段摘录；旁边显示的字数又比复制到的短（卡片里只露 60 字、详情页露 150 字，复制的是
// 1200 字符）。把真实字数写在按钮上，粘贴之前就知道拿到的是什么。
function copyButtonHtml(text, extraClass = '', label = '') {
    if (!text) return '';
    const caption = label || `复制摘录（${excerptCharCount(text)} 字符）`;
    return `<button type="button" class="copy-block-btn${extraClass ? ` ${extraClass}` : ''}" data-copy-idx="${registerCopySource(text)}">⧉ ${caption}</button>`;
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
        // 只选了一本时，「在 X – X 之间」是句废话（最小值等于最大值），改说平均水平
        if (selected.count === 1) {
            parts.push(`你选中的这 1 本，平均水平是 ${formatMetric(selected.min)}。`);
        } else {
            parts.push(`你选中的 ${selected.count} 本在 ${formatMetric(selected.min)} – ${formatMetric(selected.max)} 之间。`);
        }
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

// ==========================================
// 🎨 书名 → 颜色：三张图共用同一份映射
// ==========================================
// 热力图/折线图、风格星系、全书对比原来各建一个 d3.scaleOrdinal，range 一模一样，
// 但 domain 不一样（前两个是「当前选中的书」按点选顺序，看板是「全库」），于是
// 同一本书在不同页签是不同颜色——《白牙》在星系里是青色、到了看板变成赭色。
// 现在统一以全库顺序（Object.keys(realData)）为唯一 domain：看板的取值一位都不变，
// 另外两处（折线图、星系）向它看齐。
//
// 旁注：#b5472f 同时是 --vermilion 强调色（hover 描边、选中态、峰值点），
// 排在 0 号槽的那本书会和强调色同色。这是既有现象，不是这里引入的。
const BOOK_COLOR_RANGE = [
    '#b5472f', '#4f7a8c', '#6b8f5a', '#a67c3d',
    '#5a6b8c', '#a2546b', '#8c6f4a', '#5f7d72'
];

// 与 getBookSafeId 同一套 Java 风格字符串哈希：纯函数、确定性、不碰 Math.random
function bookColorHash(value) {
    const text = String(value ?? '');
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

// 命中全库顺序时与旧 scaleOrdinal 逐位等价（d3 就是 range[domainIndex % range.length]），
// 所以看板配色零变化。查不到只可能发生在数据加载之前，而那时三张图都还没开始画
// （initChart / initAdvancedData / initStyleGalaxy 都会在 !realData 时提前返回），
// 所以按名字哈希取色这条分支是纯防御，不追求与索引分支同色。
function bookSlot(name) {
    const keys = (realData && typeof realData === 'object') ? Object.keys(realData) : [];
    const index = keys.indexOf(String(name));
    return index >= 0 ? index : bookColorHash(name);
}

function colorForBook(name) {
    return BOOK_COLOR_RANGE[bookSlot(name) % BOOK_COLOR_RANGE.length];
}

// 只靠颜色区分书，对红绿色盲等于没区分——八种色相里他们还分得开的只有两三种，
// 而这套色板里 #b5472f / #a67c3d / #a2546b 三者的明度与色相都挨得很近。
// 所以给每条**线**再配一个线型（第二编码通道）：颜色分不出来时靠虚实分辨。
// 槽位与颜色共用 bookSlot()，同一本书的颜色和线型永远绑在一起，不会出现
// 「图例画着虚线、图上却是实线」这种自相矛盾。0 号槽是实线，所以只选中一本书时
// （默认首屏就是这一种）外观和改动前完全一样。
const BOOK_DASH_RANGE = [
    '',                 // 实线
    '10 5',
    '2 4',
    '14 4 3 4',
    '6 3 2 3',
    '1 4',
    '16 4 2 4 2 4',
    '5 3'
];

function dashForBook(name) {
    return BOOK_DASH_RANGE[bookSlot(name) % BOOK_DASH_RANGE.length];
}

// ==========================================
// ✧ 风格星系的轴词：只说实话
// ==========================================
// 说明里举的「高频小词」例子必须来自真实模型，不能写死。本项目语料是英文小说，
// 轴词是 the / his / of / he 这类英文小词，写死成中文虚词就是给用户假信息。
// 后端 src/projection.py 的 axis_labels() 已按主成分载荷算好，形如
// 「横轴越靠右，the / his / of / he 这类小词在整段里占的比例越高」，
// 经 projection.axisLabels 传到前端（renderGalaxyNote 已在用同一份数据）。
// 一条轴可能是两段（正号词一段、负号词一段，用「；」隔开），所以每段都要取。
// 取不到时（旧版数据 / 不同模型混选 / 退化模型）不编词，退回泛称。
function getAxisWordsFor(comparability) {
    const labels = (comparability && comparability.axisLabels) || [];
    const words = [];
    labels.forEach(text => {
        // 只认「，A / B / C 这类小词」里的那段词表，不把整句当词。
        // 分号也要排除，否则分号前面那段的词表会被一路吞到下一段去。
        const parts = String(text).match(/，([^，；]+?)\s*这类小词/g) || [];
        parts.forEach(part => {
            const matched = /，([^，；]+?)\s*这类小词/.exec(part);
            if (!matched) return;
            matched[1].split('/').forEach(word => {
                const trimmed = word.trim();
                if (trimmed && words.indexOf(trimmed) < 0) words.push(trimmed);
            });
        });
    });
    return words.slice(0, 4);
}

function getSelectedAxisWords() {
    return getAxisWordsFor(getGalaxyComparability(Array.from(selectedBooks)));
}

// 嵌进句子里的两种写法；没有真实轴词时都返回空串，句子照样通顺
function getAxisWordsHint() {
    const words = getSelectedAxisWords();
    return words.length ? `（${words.join(' / ')} 这类）` : '';
}

function getAxisWordsParen() {
    const words = getSelectedAxisWords();
    return words.length ? `（${words.join(' / ')}）` : '';
}

// 把轴词回填进静态 HTML 里的两个占位 span（词表为空时保持为空）
function renderAxisWordHints() {
    const hint = document.getElementById('galaxy-axis-words');
    if (hint) hint.textContent = getAxisWordsHint();
    const paren = document.getElementById('galaxy-guide-axis-words');
    if (paren) paren.textContent = getAxisWordsParen();
}

// 星系图例里「大小 = …」那行要点出当前观察角度是哪个指标。
//
// 不点出来的话，那个全局下拉的名字（「观察角度」）会让人以为它改的是点的位置——
// 位置其实恒为高频小词坐标（initStyleGalaxy 里 positionData 永远取 functionWords），
// 只有圆点大小跟着指标走。
//
// 特例：指标就是「风格走向」时不能写成「数值高低」，因为那会暗示两套独立编码。
// functionWords 的 value 恰恰就是 PCA 第一主成分（见 src/pipeline.py：item["x"] 作
// value、item["y"] 作 value_y），而横向位置用的就是同一个 pcaX——同源，得说出来。
function updateGalaxySizeHint() {
    const el = document.getElementById('galaxy-guide-size');
    if (!el) return;
    const label = (typeof getMetricLabel === 'function') ? getMetricLabel(currentMetric) : currentMetric;
    if (currentMetric === 'functionWords') {
        el.textContent = `大小 = 「${label}」的数值高低（与横向位置同源）`;
        return;
    }
    el.textContent = `大小 = 「${label}」的数值高低`;
}

// 指纹热力图图例：低值（黛蓝）↔ 高值（赤）在每个指标下的具体含义
function getHeatmapLegend(metric) {
    const legend = {
        sentenceLength: ['短句', '长句'],
        simpsonIndex: ['用词多样', '用词重复'],
        hapaxLegomena: ['用词较单调', '用词较丰富']
    };
    if (metric === 'functionWords') {
        // 功能词 PCA 的横轴＝一批高频小词在整段里的占比：靠左占比低、靠右占比高。
        // 前缀用真实模型里载荷最高的那个词（取不到就只说「小词」）。
        // 原来的「一端 / 另一端」等于什么都没说。
        const words = getSelectedAxisWords();
        const lead = words.length ? `${words[0]} ` : '小词';
        return [`${lead}占比低`, `${lead}占比高`];
    }
    return legend[metric] || ['低值', '高值'];
}

// 全书对比页有两张图，导出按钮只有一条。「导出的是当前这张图」要成立，
// 就得记住用户最后碰过的是哪张：默认「整体水平对比」，碰过走势图就跟着变。
const DASH_CHARTS = {
    'adv-mean': '整体水平对比',
    'adv-line': '风格走势'
};
let lastDashChart = 'adv-mean';

function trackDashboardCharts() {
    Object.keys(DASH_CHARTS).forEach((id) => {
        const card = document.getElementById(id);
        if (!card) return;
        const mark = () => { lastDashChart = id; };
        card.addEventListener('mouseenter', mark);
        card.addEventListener('pointerdown', mark);
        card.addEventListener('focusin', mark);
    });
}

// 导出的必须是「眼前这一张图」。
// 旧写法写死 #main-chart，于是在「风格星系」「全书对比」下点导出，
// 拿到的仍是基础趋势的热力图，跟屏幕上的图不是一回事。
function getExportTarget() {
    if (currentTab === 'view-galaxy') {
        return { element: document.querySelector('#galaxy-container svg'), label: '风格星系' };
    }
    if (currentTab === 'view-dashboard') {
        // 以前写死 #adv-mean：它恒存在，于是「风格走势」那张永远导不出来
        const element = document.querySelector(`#${lastDashChart} svg`)
            || document.querySelector('#adv-mean svg');
        return { element, label: `全书对比·${DASH_CHARTS[lastDashChart] || DASH_CHARTS['adv-mean']}` };
    }
    return {
        element: document.getElementById('main-chart'),
        label: chartType === 'line' ? '折线趋势图' : '指纹热力图'
    };
}

// 文件名里的书：多本时不再只写第一本的名字（导出的是对比图，不是单书图）
function exportFileLabel() {
    const books = Array.from(getActiveBookSet());
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

// ── 导出用的内联样式 ──────────────────────────────────────────────
// 导出物是序列化后的字符串，外部样式表不跟着走，凡是靠 d3-style.css 上色的
// 元素都得在这里重述一遍。以前这里只有 3 条规则，于是「风格走向」的 0 基线
// （<line> 没有 stroke 时默认不可见）整条消失、最高点（<circle> 没有 fill 时
// 默认纯黑）从朱红变黑点、框选矩形变成一个不透明黑块——屏幕上和导出的不是同一张图。
// 这份字符串原来在 exportChart 和 exportVectorChart 里各存一份，已经漂移过，
// 现在只留这一份。
const EXPORT_SVG_STYLE = `
    <style>
        text { font-family: 'Microsoft YaHei', sans-serif; fill: #2f2a23; }
        .heatmap-rect { stroke: ${HEATMAP_STROKE}; stroke-width: 1px; }
        .axis path, .axis line { fill: none; stroke: #98907f; shape-rendering: crispEdges; }
        .zero-line { stroke: #6b6254; stroke-width: 1; shape-rendering: crispEdges; }
        .annotation-point { fill: #b5472f; stroke: #fdf9ef; }
        .selection { fill: rgba(181, 71, 47, 0.12); stroke: #b5472f; }
        .line-path { fill: none; }
    </style>`;

// 屏幕上的图例长在图外的 HTML 里（风格星系的 #galaxy-legend、全书对比的彩色
// chip），SVG 内部一个字都没有。导出只序列化 svg，于是拿出去的 PNG/SVG 就是
// 一堆认不出谁是谁的颜色。这里在序列化之前把图例补进 svg 的副本里。
//
// 颜色不重算，直接读屏幕上已经渲染好的色值：重算要复刻渲染时的取色顺序，
// 很容易对不上；读 DOM 则天然一致。
function collectExportLegend() {
    const items = [];
    if (currentTab === 'view-galaxy') {
        document.querySelectorAll('#galaxy-legend .galaxy-legend-item').forEach(item => {
            if (item.classList.contains('galaxy-legend-skipped')) return; // 没画进图里的不列
            const swatch = item.querySelector('.galaxy-legend-swatch');
            const name = (item.textContent || '').trim();
            if (swatch && name) {
                items.push({ color: getComputedStyle(swatch).backgroundColor, name });
            }
        });
        return { items, shape: 'rect' };
    }
    if (currentTab === 'view-dashboard') {
        const seen = new Set();
        document.querySelectorAll('#adv-line .line-path').forEach(path => {
            const datum = path.__data__;
            if (!datum || seen.has(datum.id)) return;
            seen.add(datum.id);
            items.push({
                color: path.getAttribute('stroke') || datum.color,
                // 线型一并带走：导出的图例若只剩颜色，就等于把屏幕上唯一那条
                // 「不靠颜色也能分辨」的线索丢在页面里了。
                dash: path.getAttribute('stroke-dasharray') || '',
                name: datum.displayName || datum.name
            });
        });
        return { items, shape: 'line' };
    }
    return { items: [], shape: 'rect' };
}

// 风格星系的坐标轴含义也只写在图外的 #galaxy-axis-note 里，一并带走
function collectExportAxisNote() {
    if (currentTab === 'view-dashboard') {
        // 「整体水平对比」的柱子高度在框选后变成了区段口径，而说明那句话写在
        // SVG 外面的 h4 里（#adv-mean-scope）。导出只序列化 SVG，于是导出的图
        // 看着就是全书平均——一个比屏幕上更错的版本。这句话必须跟着图走。
        const scope = document.getElementById('adv-mean-scope');
        const scopeText = scope ? (scope.textContent || '').trim() : '';
        if (!scopeText) return '';
        // 只在真的导出这张条形图时加：走势图画的是整条曲线，框选只是高亮，
        // 给它挂一句「数值取的是区段平均」反而变成新的一句错话。
        const exportElement = getExportTarget().element;
        if (!exportElement || exportElement !== document.querySelector('#adv-mean svg')) return '';
        const rangeText = scopeText.replace(/^（|）$/g, '').replace(/^框选区段\s*/, '');
        return `图中各书的数值取的是框选区段 ${rangeText} 内的分段平均，不是全书平均`;
    }
    if (currentTab !== 'view-galaxy') return '';
    // 「大小 = …」那行在 #galaxy-guide 里，不在 SVG 里，导出只序列化 SVG，
    // 于是导出的星系图上有「颜色 ↔ 书名」的图例，却没有任何一句解释圆点大小。
    // 导出的图是要放进论文/汇报的那份产物，这句得跟图走，排在最前（它是图例的核心句）。
    const parts = [];
    const sizeEl = document.getElementById('galaxy-guide-size');
    const sizeText = sizeEl ? (sizeEl.textContent || '').trim() : '';
    if (sizeText) parts.push(sizeText);
    const note = document.getElementById('galaxy-axis-note');
    if (note && !note.hidden) {
        // 横轴、纵轴在 DOM 里是两个子节点，直接取整块的 textContent 会把它们粘成
        // 一句「…比例越高纵轴越靠上…」，读起来像缺了标点
        const noteParts = note.children.length
            ? Array.from(note.children).map(c => (c.textContent || '').trim()).filter(Boolean)
            : [(note.textContent || '').trim()];
        noteParts.forEach(text => { if (text) parts.push(text); });
    }
    return parts.join('；').replace(/\s+/g, ' ');
}

function exportLegendLineHeight() { return 18; }

// 轴说明的折行。算高度和画文字**必须**都走这一个函数：以前两边各写各的
// （高度按 Math.ceil(len/46) 估、画的时候按 i += 46 且硬顶 4 行），一旦说明超过
// 4 行或长度不是 46 的整数倍，两者就对不上，图例带会盖住图或多出一截空白。
// 折行优先断在「；」处（那是前后两段轴的天然断点），单段超长才按 46 字硬折。
function wrapAxisNote(axisNote) {
    const MAX = 46;
    // 上限从 6 提到 7：星系的说明多了「大小 = …」一行（大小那行 + 两条轴说明 +
    // 范围说明 实测正好折到 6 行），刚好顶到上限就没有余量了，再多一条告警就会
    // 从尾部吃掉一整段。高度和画字都走这个函数，改了不会失配。
    const MAX_LINES = 7;
    const lines = [];
    String(axisNote).split('；').forEach((seg, idx) => {
        // 分号被 split 吃掉了，除第一段外都要补回来
        let rest = idx === 0 ? seg : '；' + seg;
        while (rest.length > MAX) {
            lines.push(rest.slice(0, MAX));
            rest = rest.slice(MAX);
        }
        if (!rest.length) return;
        // 塞得进上一行就塞，免得为几个字多占一整行
        const last = lines.length - 1;
        if (last >= 0 && lines[last].length + rest.length <= MAX) lines[last] += rest;
        else lines.push(rest);
    });
    if (!lines.length) return [''];
    if (lines.length > MAX_LINES) {
        // 真被截断时留个记号，别让导出的图悄悄少一段
        const kept = lines.slice(0, MAX_LINES);
        kept[MAX_LINES - 1] = kept[MAX_LINES - 1].slice(0, MAX - 1) + '…';
        return kept;
    }
    return lines;
}

// 图例带的高度：每条图例一行，轴说明按 wrapAxisNote 的实际行数
function exportLegendBandHeight(items, axisNote) {
    if (!items.length && !axisNote) return 0;
    const lineH = exportLegendLineHeight();
    let lines = items.length;
    if (axisNote) lines += wrapAxisNote(axisNote).length;
    return lines * lineH + 16;
}

// 三种图的 svg 尺寸写法并不统一：基础趋势/全书对比是 viewBox + inline 高度，
// 风格星系是 width/height 属性。这里统一成「viewBox + width/height 属性」，
// 并清掉 inline 高度——否则序列化出来的 style="height:400px" 会压住新加的图例带。
function prepareExportSvg(svg, extraHeight) {
    const clone = svg.cloneNode(true);
    const box = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const rect = svg.getBoundingClientRect();
    let vbX = 0, vbY = 0, vbW, vbH;
    if (box.length === 4 && box.every(n => isFinite(n))) {
        [vbX, vbY, vbW, vbH] = box;
    } else {
        vbW = Number(svg.getAttribute('width')) || rect.width || 800;
        vbH = Number(svg.getAttribute('height')) || rect.height || 400;
    }
    const totalH = vbH + extraHeight;
    clone.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${totalH}`);
    clone.setAttribute('width', String(vbW));
    clone.setAttribute('height', String(totalH));
    clone.style.height = '';
    return { clone, vbX, vbY, vbW, vbH, totalH };
}

function attachExportLegend(prep, items, axisNote, shape) {
    if (!items.length && !axisNote) return;
    const NS = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(NS, 'g');
    const x0 = prep.vbX + 24;
    const lineH = exportLegendLineHeight();
    let y = prep.vbY + prep.vbH + 26;

    const addText = (x, ty, size, fill, content) => {
        const text = document.createElementNS(NS, 'text');
        text.setAttribute('x', String(x));
        text.setAttribute('y', String(ty));
        text.setAttribute('font-size', String(size));
        text.setAttribute('fill', fill);
        text.textContent = content;
        g.appendChild(text);
    };

    items.forEach(item => {
        if (shape === 'line') {
            const seg = document.createElementNS(NS, 'line');
            seg.setAttribute('x1', String(x0));
            seg.setAttribute('x2', String(x0 + 16));
            seg.setAttribute('y1', String(y - 4));
            seg.setAttribute('y2', String(y - 4));
            seg.setAttribute('stroke', item.color);
            seg.setAttribute('stroke-width', '2');
            if (item.dash) seg.setAttribute('stroke-dasharray', item.dash);
            g.appendChild(seg);
        } else {
            const swatch = document.createElementNS(NS, 'rect');
            swatch.setAttribute('x', String(x0));
            swatch.setAttribute('y', String(y - 11));
            swatch.setAttribute('width', '12');
            swatch.setAttribute('height', '12');
            swatch.setAttribute('rx', '3');
            swatch.setAttribute('fill', item.color);
            g.appendChild(swatch);
        }
        addText(x0 + 22, y, 12, '#2f2a23', item.name);
        y += lineH;
    });

    if (axisNote) {
        // 轴说明是整句，折行免得一行横穿整张图；行数由 wrapAxisNote 决定，
        // 与上面 exportLegendBandHeight 用的是同一个函数，不会对不上
        wrapAxisNote(axisNote).forEach(line => {
            addText(x0, y, 11, '#5c5346', line);
            y += lineH;
        });
    }

    g.setAttribute('class', 'export-legend');
    prep.clone.appendChild(g);
}

// 把图例和轴说明拼上去，返回可直接序列化的 svg 副本
function buildExportSvg(svg) {
    const legend = collectExportLegend();
    const axisNote = collectExportAxisNote();
    const extra = exportLegendBandHeight(legend.items, axisNote);
    const prep = prepareExportSvg(svg, extra);
    attachExportLegend(prep, legend.items, axisNote, legend.shape);
    return prep;
}

function serializeExportSvg(prep) {
    let source = new XMLSerializer().serializeToString(prep.clone);
    if (!source.match(/^<svg[^>]+xmlns="http\:\/\/www\.w3\.org\/2000\/svg"/)) {
        source = source.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    return source.replace('</svg>', EXPORT_SVG_STYLE + '</svg>');
}

function exportChart() {
    const target = getExportTarget();
    const svg = target.element;
    if (!svg) {
        showError(getNoChartMessage());
        return;
    }

    const prep = buildExportSvg(svg);
    const imageSrc = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(serializeExportSvg(prep));

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const img = new Image();

    // 画布尺寸取 viewBox 而不是屏幕上的 getBoundingClientRect()：
    // viewBox 才是这张图自己的坐标系，加了图例带之后两者的高度不再相等。
    const scaleFactor = 2;
    canvas.width = prep.vbW * scaleFactor;
    canvas.height = prep.totalH * scaleFactor;

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
    // 用 getExportBooks() 而不是直接读 selectedBooks：「全书对比」页上的书籍筛选
    // 也要算数，否则点掉的书仍会在摘要里占一整节
    const books = getExportBooks();
    if (books.length === 0) {
        const pool = getActiveBookSet();
        if (!realData || !pool || pool.size === 0) {
            showError('当前没有可导出的分析数据。请先选择书籍或上传文本。');
        } else {
            showError('当前选择的书籍暂时没有可用于这个观察角度的数据，请换一个角度，或换一本书再试。');
        }
        return;
    }

    const metricLabel = getMetricLabel(currentMetric);
    const metricHint = {
        sentenceLength: '一句话平均几个词。',
        simpsonIndex: '数值越高，用词越重复。',
        hapaxLegomena: '由「总词数、不同词的个数、只出现过一次的词数」综合算出，不是 0–1 的比例；数值越大用词越丰富。已按篇幅折算，长短不同的书可比。',
        functionWords: `由高频小词${getAxisWordsHint()}的使用习惯得出，仅作参照。`
    }[currentMetric] || '';
    const contextLine = getMetricContextLine(currentMetric);
    // 纯文本（.txt）而不是 Markdown：这份摘要的读者是文科研究者，打开它的是记事本、
    // Word 或 Word 里的「插入文件」；满屏 # 和 > 在那些地方是噪音，不是格式。
    // 分隔用一条等长横线，小标题用【】，两者在任何纯文本编辑器里都读得通。
    const lines = [
        '文印·文学指纹分析摘要',
        '════════════════════════════════════════',
        '',
        `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
        `- 当前视图：${currentTab === 'view-main' ? (chartType === 'line' ? '基础趋势分析 · 折线趋势图' : '基础趋势分析 · 指纹热力图') : currentTab === 'view-galaxy' ? '风格星系' : '全书对比'}`,
        `- 观察角度：${metricLabel}`,
        `- 怎么理解：${metricHint}`,
        `- 统计范围：${describeExportScope()}`,
        ...(contextLine ? [`- 解读参考：${contextLine}`] : []),
        `- 选择书籍：${books.map(getBookDisplayName).join('、')}`,
        `- 在线视图（打开即还原本次选择）：${buildStateUrl()}`,
        ''
    ];

    // 结论区。屏幕上「一句话解读」「值得一看的片段」是用户最想带走的东西，
    // 之前摘要里一个字都没有，只能手抄。放在每本书的明细**前面**——它是结论，不是附录。
    const insightText = buildInsightText();
    if (insightText) {
        lines.push('【一句话解读】');
        lines.push(insightText);
        lines.push('');
    }
    const anomalyText = buildAnomalyText();
    if (anomalyText) {
        lines.push('【值得一看的片段】');
        lines.push(anomalyText);
        lines.push('');
    }

    books.forEach(book => {
        // 框选生效时只统计框选内的片段，和屏幕上显示的是同一批
        const allValues = getMetricValues(book, currentMetric);
        const brush = getBrushBlockRange(book);
        const values = brush ? allValues.filter((d, i) => i >= brush.from && i <= brush.to) : allValues;
        lines.push(`【${getBookDisplayName(book)}】`);
        lines.push(`- 参与统计的片段数：${values.length}（全书共 ${getBookBlockCount(book)} 个片段）`);
        if (brush) {
            lines.push(`- 本次统计的片段：第 ${brush.from + 1}–${brush.to + 1} 个片段`);
        }
        if (values.length === 0) {
            // 这本书比框选的区段还短，一个片段都没落进来。不能继续往下算均值。
            lines.push('- 框选范围内没有这本书的片段，本节的均值、最高片段均无法给出。');
            lines.push('');
            return;
        }
        const mean = d3.mean(values, d => d.value);
        const peak = values.reduce((best, current) => current.value > best.value ? current : best, values[0]);
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
        lines.push('【方法说明】');
        lines.push(methods);
        lines.push('');
    }

    lines.push('说明：本摘要用于记录当前页面的选择。图中的数值与位置只是风格方面的数据，请结合作品原文与具体片段理解，不宜单独当作文学质量高低的评判。');

    downloadBlob(lines.join('\n'), `文印_分析摘要_${exportTimestamp()}.txt`, 'text/plain;charset=utf-8');
}

// 「一句话解读」的纯文字版本。内容是页面内那段脚本渲染时存进 lastInsightLines 的，
// 所以这里拿到的永远是屏幕上那几句（含框选口径说明那句），不会另算一套、也就不会打架。
function buildInsightText() {
    const lines = Array.isArray(lastInsightLines) ? lastInsightLines.filter(Boolean) : [];
    return lines.join('\n');
}

// 异常面板脚注的三句话，屏幕与导出共用（第十一批、第十五批都吃过「两处各说一套」的亏）。
// 它们分别管三件最容易被读错的事：这只是描述性的「离整体远」、列表有上限、
// 相邻片段大面积重叠所以不是互相独立的样本。
function anomalyNotes(report) {
    const notes = ['这里的「偏离」只是统计意义上离整体较远（离均值超过 2 个标准差，或超出四分位距范围），不代表写得好或不好。'];
    // 接口把 items 截断到 8 条，counts.total 才是「一共找出多少个」。
    // 不说这一句，读者会把列出的这 8 条当成全集，写成「全书共 8 个偏离片段」。
    if (report && isFiniteNumber(report.flagged) && report.flagged > report.items.length) {
        notes.push(`本书共找出 ${report.flagged} 个偏离片段，这里按偏离程度只列出最靠前的 ${report.items.length} 个。`);
    }
    // 片段是 blockSize/overlap 的滑窗切出来的，相邻两条共享九成原文。
    // 在近重复的序列上算 ±2σ，那个「2 个标准差」就不再是它字面上给人的「罕见」了。
    if (report && report.blockCount > 0) {
        const overlapPart = isFiniteNumber(report.overlap) && report.overlap > 0
            ? `，相邻片段之间重叠约 ${report.overlap} 词、并不是互相独立的样本`
            : '，相邻片段之间有大段重叠、并不是互相独立的样本';
        notes.push(`这次统计基于本书的 ${report.blockCount} 个片段${overlapPart}，所以它只适合用来挑原文，不构成显著性结论。`);
    }
    return notes;
}

// 「值得一看的片段」的纯文字版本，同样取自屏幕上那一份（lastAnomalyReports）。
// 还没加载出来（没进「全书对比」页）时返回空串，调用方据此跳过这一节——
// 宁可不说，也不要在导出物里编一段屏幕上没有的话。
// 但「取不到」和「没去看过」是两回事：前者屏幕上已在面板里说明了原因，
// 导出物里也必须写出来，否则读的人只会以为这本书没有偏离片段。
// 屏幕上是逐本一块，这里就是逐本一段，中间空一行隔开；只选一本书时输出与以前逐字节相同。
function buildAnomalyText() {
    const reports = Array.isArray(lastAnomalyReports) ? lastAnomalyReports.filter(Boolean) : [];
    if (reports.length === 0) return '';
    return reports.map(anomalyTextForReport).filter(Boolean).join('\n\n');
}

function anomalyTextForReport(report) {
    if (!report) return '';
    const head = `《${report.displayName}》（观察角度：${report.metricLabel}）`;
    if (report.failed) {
        return `${head}\n  这一节这次没有生成：${report.reason}`;
    }
    if (!Array.isArray(report.items)) return '';
    // 「均值来自 /api/analysis、不随框选变」这件事必须在导出物里也说一遍，
    // 否则读者会把这里的平均和「整体水平对比」上那个被框选改过的数当成同一个。
    const scopeNote = report.brushScoped ? '，不受框选影响' : '';
    const meanPart = Number.isFinite(report.mean) ? `，比全书平均（${formatMetric(report.mean)}${scopeNote}）` : '';
    if (report.items.length === 0) {
        return `${head}\n它在这个角度上整体比较均匀，没有特别偏离的片段。`;
    }
    const blocks = report.items.map(item => {
        const value = Number(item.value);
        const dirText = Number(item.zScore) > 0 ? '偏高' : '偏低';
        const location = (typeof formatBlockLocation === 'function')
            ? formatBlockLocation(report.book, item.block)
            : `第 ${Number(item.block) + 1} 个片段`;
        const out = [
            `  ${dirText} · ${location}`,
            `    ${report.metricLabel} ${Number.isFinite(value) ? formatMetric(value) : ''}`
                + (meanPart ? `${meanPart}${dirText} ${formatMetric(Math.abs(report.mean - value))}` : '')
        ];
        if (item.preview) out.push(`    原文：“${String(item.preview).replace(/\r?\n/g, ' ').trim()}”`);
        if (Array.isArray(item.keywords) && item.keywords.length) out.push(`    关键词：${item.keywords.join('、')}`);
        return out.join('\n');
    });
    blocks.push(`  说明：${anomalyNotes(report).join('')}`);
    return [head, ...blocks].join('\n');
}

// 「复制结论」：把「一句话解读」和「值得一看的片段」一起复制成纯文字，直接粘进笔记。
// 两块口径不同（解读跟着框选走、异常片段固定按全书），所以各占一段，不混成一句。
function copyConclusion(button) {
    const parts = [buildInsightText(), buildAnomalyText()].filter(Boolean);
    if (parts.length === 0) {
        setGlobalStatus('notice', '现在还没有可复制的结论。请切到「全书对比」页，选择书籍后这里就会生成解读。');
        return;
    }
    const header = `文印·文学指纹分析 · 结论（观察角度：${getMetricLabel(currentMetric)}；统计范围：${describeExportScope()}）`;
    copyTextToClipboard([header, '', parts.join('\n\n')].join('\n'), button, '✓ 结论已复制');
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

// 当前屏幕上真正参与分析的那几本书。
// 选书全项目只有一份 selectedBooks：顶部书名按钮与「全书对比」页的 chips 读写的是
// 同一个集合，所以这里不需要再按标签页分情况。导出与分享链接一律以它为准，于是同一份
// 导出里的「选择书籍」与「解读参考」必然同源，不会再出现一个说 1 本、一个说 2 本。
function getActiveBookSet() {
    return selectedBooks;
}

// 导出的书名清单：当前选中、且在这个观察角度下确实有数据
function getExportBooks() {
    const source = getActiveBookSet();
    if (!realData || !source || source.size === 0) return [];
    return Array.from(source).filter(book => getMetricValues(book, currentMetric).length > 0);
}

// 「全书对比」页上走势图被框选的范围（0–1 的阅读进度比例）；没框选时返回 null。
// 那一页的均值、片段数都按这个范围算，导出必须跟着走——否则同一份分析在屏幕上
// 和导出物里是两个数，用户把导出的数字贴进论文就会和图上看到的对不上。
function getActiveBrushRange() {
    try {
        if (typeof advState === 'undefined' || !advState) return null;
        const range = advState.brushRange;
        if (!Array.isArray(range) || range.length !== 2 || !range.every(isFiniteNumber)) return null;
        const lo = Math.max(0, Math.min(range[0], range[1]));
        const hi = Math.min(1, Math.max(range[0], range[1]));
        return hi > lo ? [lo, hi] : null;
    } catch (e) {
        return null; // advState 定义在页面内的另一段脚本里，取不到就当作没框选
    }
}

// 框选范围换算成某本书的片段下标区间。用的是屏幕上那套算法：
// 第 i 个片段的 xPercent = i / (片段数 - 1)，落在 [min, max] 内才算选中。
// 片段下标与块下标是同一个编号（四个指标每个块各一条记录）。
function getBrushBlockRange(bookName) {
    const range = getActiveBrushRange();
    if (!range) return null;
    const len = getMetricValues(bookName, currentMetric).length;
    if (!len) return { from: 0, to: -1, count: 0 };
    const denom = len - 1 || 1;
    const from = Math.ceil(range[0] * denom);
    const to = Math.floor(range[1] * denom);
    return { from, to, count: Math.max(0, to - from + 1) };
}

// 导出物里那句范围说明：框选时点名范围，没框选时明写「全书」
function describeExportScope() {
    const range = getActiveBrushRange();
    if (!range) return '全书全部片段';
    return `走势图框选的 ${(range[0] * 100).toFixed(1)}%–${(range[1] * 100).toFixed(1)}% 区段（与「全书对比」页上的数字同一口径）`;
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
    parts.push(`本次分析使用「文印」文学指纹工具，共分析 ${books.length} 本书、${totalBlocks} 个片段。`);
    // 来源要说准：clean_text 对**所有**书都跑，但只有带 Gutenberg 页眉页脚的文件才真被剥掉那层。
    // 原来那句话读起来像「每本书都清理过 Gutenberg 页眉」，对上传的其它来源文本是假话。
    parts.push(`文本统一空白、还原常见缩写；若来自 Project Gutenberg，另清理其页眉页脚（其它来源的文本原样保留，没有这层清理）。按每片段 ${blockSizes.join('/')} 词、相邻片段重叠 ${blockSizes.map((size, i) => size - steps[i]).join('/')} 词的滑动窗口切分。`);
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

        // 框选生效时只导框选内的片段（屏幕上的均值就是按这些片段算的）
        const brush = getBrushBlockRange(book);
        for (let i = 0; i < totalBlocks; i += 1) {
            if (brush && (i < brush.from || i > brush.to)) continue;
            const chapter = getBlockChapter(book, i);
            const words = series.functionWords.get(i) || series.sentenceLength.get(i) || {};
            const value = (key) => {
                const item = series[key].get(i);
                return item && isFiniteNumber(item.value) ? String(item.value) : '';
            };
            const style = series.functionWords.get(i);
            rows.push([
                getBookDisplayName(book), // 表头是「书名」，与摘要/参考文献里的中文名保持一致
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
        `# 统计范围：${describeExportScope()}`,
        `# 片段口径：${windowSpecs.join('；')}。同一段原文会被反复计入，请勿把这些行当作互相独立的样本，按行做显著性检验会高估样本量。`,
        `# 数据行数：${rows.length - 1}`
    ];

    // 带 BOM：Excel 打开中文 CSV 默认按本地编码解析，没有 BOM 会乱码
    const csv = `${comments.join('\r\n')}\r\n${body}`;
    downloadBlob('﻿' + csv, `文印_数据表_${exportTimestamp()}.csv`, 'text/csv;charset=utf-8');
}

// 内置示例书的原著信息。取自 data/raw/ 下各 txt 开头那段 Project Gutenberg 头部
// （Title / Author / Release date / eBook #）；year 是该作品**首次出版**的年份，
// 不是电子版的发布日期——后者写在 note 里，两者别混。
// 只有这四本拿得到原著信息；用户上传的文本没有可靠的作者与版本，不能替他们编一个。
const BUILTIN_BOOK_SOURCES = {
    'the adventures of tom sawyer': {
        key: 'twain1876tomsawyer', author: 'Twain, Mark', title: 'The Adventures of Tom Sawyer',
        year: 1876, ebook: 74, released: '2004-07-01'
    },
    'the adventures of huckleberry finn': {
        key: 'twain1884huckleberryfinn', author: 'Twain, Mark', title: 'Adventures of Huckleberry Finn',
        year: 1884, ebook: 76, released: '2004-06-29'
    },
    'the call of the wild': {
        key: 'london1903callofthewild', author: 'London, Jack', title: 'The Call of the Wild',
        year: 1903, ebook: 215, released: '2008-07-02'
    },
    'white fang': {
        key: 'london1906whitefang', author: 'London, Jack', title: 'White Fang',
        year: 1906, ebook: 910, released: '1997-05-01'
    }
};

// 书名 → 原著信息；查不到（用户上传的）返回 null。
// 比对前先去掉首尾空格、转小写：书单的兜底文案里把「The call of the wild」写成了
// 「The Call of the Wild」，大小写不该让一条原著条目凭空消失。
function getBuiltinBookSource(name) {
    if (typeof name !== 'string') return null;
    return BUILTIN_BOOK_SOURCES[name.trim().toLowerCase()] || null;
}

// 导出引用条目（BibTeX）：给报告、论文的参考文献用
function exportCitation() {
    const books = getExportBooks();
    if (books.length === 0) {
        showError('当前没有可导出的分析数据。请先选择书籍或上传文本。');
        return;
    }

    // 片段数与摘要/CSV 同口径：有框选时只算框选内的片段
    const totalBlocks = books.reduce((sum, book) => {
        const brush = getBrushBlockRange(book);
        if (brush) return sum + brush.count;
        const meta = normalizeBookMeta(book);
        return sum + ((meta && meta.totalBlocks) || 0);
    }, 0);
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

    // 原著条目。学生把这段贴进参考文献时，真正要引的是作品本身，不是这个工具；
    // 旧版只发一条 author = 本工具的 @misc，等于把「文印」写成了《白牙》的作者，
    // 而句子长度曲线并不能替原著背书。
    const sources = books.map(name => ({ name, src: getBuiltinBookSource(name) }));
    const knownSources = sources.filter(s => s.src);
    const unknownNames = sources.filter(s => !s.src).map(s => s.name);

    const chunks = [
        '文印 · 引用条目',
        '本文件有两类条目，别混用：',
        '  1. @book —— 本次分析用到的内置示例书，引用文学作品本身时用这一条。',
        '     year 是作品首次出版的年份；电子版的来源与发布日期写在 note 里。',
        '  2. @misc —— 本次在线分析记录本身（哪一次、什么参数、跑了哪几本书），不是出版物。',
        ''
    ];

    knownSources.forEach(({ src }) => {
        chunks.push([
            `@book{${src.key},`,
            `  author    = {${src.author}},`,
            `  title     = {${src.title}},`,
            `  year      = {${src.year}},`,
            `  publisher = {Project Gutenberg},`,
            `  note      = {电子文本：Project Gutenberg eBook \\#${src.ebook}，发布于 ${src.released}},`,
            `  url       = {https://www.gutenberg.org/ebooks/${src.ebook}}`,
            '}',
            ''
        ].join('\n'));
    });

    if (unknownNames.length > 0) {
        chunks.push(`注：${unknownNames.map(n => `《${getBookDisplayName(n)}》`).join('、')}是你上传的文本，`
            + '本文件没有它的原著条目——上传的文件里读不到作者与版本，替你编一个比空着更糟。请按手上的版本自行补全。');
        chunks.push('');
    }

    // @misc 这条描述的是「本次在线分析」，不是正式出版物。
    // 每个字段末尾都要有逗号（BibTeX 靠逗号分字段，漏一个会整条报错、
    // 丢掉除标题外的全部字段）；最后一行 url 后面不能有逗号。
    chunks.push([
        `@misc{${key},`,
        `  title        = {文印·文学指纹分析记录：${books.map(name => `{${getBookDisplayName(name)}}`).join('、')}},`,
        `  author       = {{文印（文学指纹分析工具）}},`,
        `  year         = {${now.getFullYear()}},`,
        `  month        = {${monthNames[now.getMonth()]}},`,
        `  howpublished = {在线交互式分析（Keim \\& Oelke 2007 指标口径）},`,
        `  note         = {观察角度：${getMetricLabel(currentMetric)}；分析片段数：${totalBlocks}；统计范围：${describeExportScope()}${sharedModel ? `；坐标模型：${sharedModel.modelId}` : ''}${localUrlNote}${knownSources.length ? `；原著条目见本文件开头的 @book` : ''}；本条描述的是本文档生成时的一次在线分析记录，并非正式出版物，正式引用请以原著版本为准},`,
        `  url          = {${buildStateUrl()}}`,
        '}',
        ''
    ].join('\n'));

    downloadBlob(chunks.join('\n'), `文印_引用_${exportTimestamp()}.bib`, 'application/x-bibtex;charset=utf-8');
}

// 导出矢量图（SVG）：论文排版放大不糊
function exportVectorChart() {
    const target = getExportTarget();
    const svg = target.element;
    if (!svg) {
        showError(getNoChartMessage());
        return;
    }

    const source = serializeExportSvg(buildExportSvg(svg));
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

// 加载提示统一带上「可能要等多久」。这一条不能只写在详情卡里：带 ?view=dashboard 的链接
// 进来时 #detailPanel 是隐藏的（它长在 #view-main 里），顶部状态条才是唯一看得见的反馈。
// 而这两个接口的第一次都可能很慢——api_server.py 里 /api/books 和 /api/fingerprint-data
// 都会走 _ensure_demo_data()，首次要现场生成示例数据（那儿的注释写着重算要跑 1~3 分钟），
// 光一句「正在加载数据...」在那三分钟里和没有提示是一样的。
const LOADING_WAIT_HINT = '如果这台服务刚启动，需要先生成示例数据，可能要等 1–3 分钟，页面没有卡死。';

// 「加载中」「出错」这两张状态卡**不参与读屏播报**（aria-hidden），因为同一句话已经由
// 顶部状态条那个 live region 念过一遍了——两块同时可见时，读屏会把整句话连读两遍。
// 判据是「状态条上那条消息会不会比卡片先消失」：setGlobalStatus 只让 success/notice
// 在 6 秒后自己收起，loading 和 error 会一直留到下一次状态更新。所以这两张卡片被摘掉
// 也丢不了信息。反过来，「没有数据」那张卡片不摘：它的状态条 6 秒就没了。
// （第二十批起「成功」那张卡不存在了：数据加载完，右侧面板换成了「先看这 3 段」——
//   那是一块能点进去的内容，不是状态话，所以也不标 aria-hidden。）
// 用 aria-hidden 而不是临时摘掉 #detailPanel 的 role/aria-live：后者要再设回去，而
// 「live region 从非 live 变成 live 时，已有内容算不算一次新播报」各家读屏不一致，
// 一旦判错，正常的片段详情卡（点数据点弹出来的那张）就整个不播了——那是回退，不是修复。
function showLoading(message) {
    setGlobalStatus('loading', `${message} ${LOADING_WAIT_HINT}`);
    const detailPanel = document.getElementById('detailPanel');
    if (!detailPanel) return;
    detailPanel.innerHTML = `
        <div class="state-card loading" aria-hidden="true">
            <h3>◌ ${escapeHtml(message)}</h3>
            <p>${escapeHtml(LOADING_WAIT_HINT)}</p>
            <div class="state-spinner" aria-hidden="true"></div>
        </div>
    `;
}

function showError(message) {
    setGlobalStatus('error', message);
    showGalaxyError(message);
    // 状态条滚出屏幕外时补一条贴底的提示，否则「点了没反应」。
    // 判断必须放在 setGlobalStatus 之后：是它负责把状态条显示出来的，在那之前量不到它的位置。
    // announce:false——同一句话已经由状态条那个 live region 念过，别让读屏连读两遍。
    if (statusBarOffscreen()) {
        showSelectionNotice(message, { announce: false, duration: 7000 });
    }
    const detailPanel = document.getElementById('detailPanel');
    if (!detailPanel) return;
    detailPanel.innerHTML = `
        <div class="detail-card state-card error" aria-hidden="true">
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

// 详情卡记的是「某个片段在某个指标下的数值」。换过观察角度、换过书之后图会重画，
// 那张卡却原样留着——纵轴已经变成「用词重复度」，卡片里还写着「平均句长 24.97」，
// 看上去就像是当前这张图上的数字。这里把它打回未选择状态，并说明为什么没了。
//
// 只在「指标变了」「选中的书变了」这两处调。换图形（热力图 ↔ 折线）不影响卡里的内容；
// 窗口 resize 更不该把用户刚点开的卡抹掉——那两处都会经过 refreshAllActiveCharts。
//
// 判据用卡里独有的 .block-location，而不是另立一个「现在有没有卡」的变量：写这块面板的
// 地方有六处，多一个要同步的状态就多一个能漂移的地方。加载中/失败的卡没有这个类，不受影响。
function resetDetailPanelIfStale(reason) {
    const detailPanel = document.getElementById('detailPanel');
    if (!detailPanel || !detailPanel.querySelector('.block-location')) return;
    detailPanel.innerHTML = `
        <h3>▤ 数据详情</h3>
        <p>${escapeHtml(reason)}后，之前选中的那个点已经取消，重新点一下即可查看。</p>
    `;
}

// 顶部状态条长在页面最上面。切页签会滚到视图顶部，用户已经在看「全书对比」「风格星系」时，
// 这条消息落在视口上方几百像素处——点「导出图像」失败看上去就像没反应。
// 「看不看得见」是几何问题，就用几何量判断，不另立标志位：滚动位置是唯一的事实来源。
function statusBarOffscreen() {
    const el = document.getElementById('global-status');
    if (!el || el.hidden) return true;
    const rect = el.getBoundingClientRect();
    return rect.bottom <= 1 || rect.top >= window.innerHeight - 1;
}

// ==========================================
// ✧ 风格星系 (Style Galaxy)
// ==========================================

let galaxySimulation = null;
let lastGalaxyTrigger = null;

// 上一次算出来的点位（片段 id → 坐标）。进入星系时，力导向原本每次都从「投影位置」
// 重新起步、跑约 300 次迭代（约 5 秒）才稳定：切页签、换指标、换书、拖窗都要重看
// 一遍这场抖动，而且用户手动拖开的那几个点会被拉回原位。有力导布局就必然要收敛，
// 但没必要每次都从零开始——从上次的结果接着算，几十次迭代就稳了。
// 「↻ 重新布局」按钮会先清空它，那个按钮的承诺（真的重新排一次）因此不受影响。
const galaxyPositions = new Map();

function initStyleGalaxy() {
    // 检查是否可见
    if (currentTab !== 'view-galaxy') return;

    // 说明文案里的轴词例子跟着当前书目走（一本都没选时自动清空，退回泛称）
    renderAxisWordHints();
    // 「大小 = …」跟着当前指标走；放在这里而不是 renderAxisWordHints 里，
    // 那个函数的名字管的是轴词。指标切换会走 refreshAllActiveCharts → 本函数。
    updateGalaxySizeHint();

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

    // 颜色图例：让用户知道每种颜色对应哪本书
    const legendEl = document.getElementById('galaxy-legend');
    if (legendEl) {
        legendEl.innerHTML = '';
        books.forEach(book => {
            const item = document.createElement('span');
            item.className = 'galaxy-legend-item';
            const swatch = document.createElement('span');
            swatch.className = 'galaxy-legend-swatch';
            swatch.style.background = colorForBook(book);
            item.appendChild(swatch);
            item.appendChild(document.createTextNode(getBookDisplayName(book)));
            if (skippedBooks.has(book)) {
                item.classList.add('galaxy-legend-skipped');
                item.appendChild(document.createTextNode('（未画入）'));
            }
            legendEl.appendChild(item);
        });
    }

    // 只给真正画进这张图的书建渐变：圆点来自 plotBooks（图例仍遍历 books，
    // 那是为了把「未画入」的书也列出来），给跳过不画的书建渐变只会留下一批
    // 没有任何 url(#…) 引用的死 defs
    plotBooks.forEach((book) => {
        const baseColor = d3.color(colorForBook(book));
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
        // 这里原来引用了一个从未声明的 loadingEl，会抛 ReferenceError：
        // 画布已经清空，用户看到的是空白一片且没有任何说明；异常还会冒泡到
        // handleFileUpload 的 catch，把一次成功的上传误报成「上传失败」。
        // setGalaxyLoading 本来就是这个状态该用的函数。
        setGalaxyLoading('这几本书暂时缺少生成风格星系所需的高频小词数据。请换几本书再试。');
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
        // 有上次落点就从上一次接着算（见 galaxyPositions 的说明）。只在落点仍落在
        // 这一屏里时才用：换了几本书就看不清，坐标尺可能整个变了，旧点位跑到屏外
        // 反而要花更久才被拉回来。
        const cached = galaxyPositions.get(d.id);
        if (cached && cached.x >= 0 && cached.x <= width && cached.y >= 0 && cached.y <= height) {
            d.x = cached.x;
            d.y = cached.y;
        }
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
        // 起步 alpha 和衰减率都调过：默认 alpha=1、alphaDecay≈0.023，要跑约 300 次
        // 迭代（约 5 秒）才到静止。起点通常已经是上一轮的稳态，用不着从零重新退火。
        .alpha(0.35)
        .alphaDecay(0.06)
        .alphaTarget(0)
        .on("tick", ticked);

    const circles = g.selectAll("circle")
        .data(allNodes)
        .enter().append("circle")
        .attr("r", d => d.r)
        .attr("fill", d => `url(#grad-${getBookSafeId(d.book)})`)
        .attr("stroke", d => d3.color(colorForBook(d.book)).darker(0.5))
        .attr("stroke-width", 0.5)
        .attr("stroke-opacity", 0.8)
        .attr("role", "button")
        .attr("aria-label", d => `${getBookDisplayName(d.book)} 第 ${d.blockIndex + 1} 个片段，${getMetricLabel(currentMetric)} ${formatMetric(d.realValue)}`)
        .style("cursor", "pointer")
        .call(d3.drag()
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended));

    circles.on("mouseover", function(event, d) {
        d3.select(this)
            .transition().duration(motionDuration(100))
            .attr("r", d.r * 1.5)
            .style("filter", "url(#glow)")
            .attr("stroke", "#2f2a23")
            .attr("stroke-width", 2);
        
        const allCircles = g.selectAll("circle");
        const allNodeData = allCircles.data();
        const neighbors = findNeighbors(d, allNodeData, 120);
        // 用 Set 而不是数组 includes：neighbors 最多和全图节点数同量级，
        // 逐个 includes 在「邻居多」时退化成 O(n²)，扫一圈圆点就是上万次线性查找。
        const neighborSet = new Set(neighbors);

        allCircles.filter(node => neighborSet.has(node))
            .transition().duration(motionDuration(100))
            .attr("stroke", "#b5472f")
            .attr("stroke-width", 1.5)
            .attr("stroke-opacity", 1);

        const analysis = analyzeCluster(neighbors);
        const label = window.getMetricLabel ? getMetricLabel(currentMetric) : currentMetric;
        updateHUD(analysis, label);

        // value 传原始数值，不在这里先格式化：showTooltip 统一走 formatMetric，
        // 否则这里传字符串进去会命中 formatMetric 的 !isFiniteNumber 分支显示「暂无」。
        showTooltip(event, {
            block: d.blockIndex,
            value: d.realValue,
            keywords: d.keywords,
            preview: d.preview
        }, d.book);
    })
    .on("mouseout", function(event, d) {
        d3.select(this)
            .transition().duration(motionDuration(200))
            .attr("r", d.r)
            .style("filter", null)
            .attr("stroke", d3.color(colorForBook(d.book)).darker(0.5))
            .attr("stroke-width", 0.5);

        g.selectAll("circle")
             .transition().duration(motionDuration(200))
             .attr("stroke", node => d3.color(colorForBook(node.book)).darker(0.5))
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
        // 触屏上点一下会连带触发一次合成的 mouseover（于是弹出小提示框），
        // 却没有对应的 mouseout——那个提示框会一直挂在屏幕上。点开全屏详情之后
        // 它更没有存在的必要，直接收掉。
        hideTooltip();
        openGalaxyModal(d);
    })
    .on("keydown", (event, d) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            lastGalaxyTrigger = event.currentTarget;
            openGalaxyModal(d);
            return;
        }
        // ← →（以及 ↑ ↓）沿片段顺序前后移动焦点，Home / End 跳首尾。
        // 星系是散点，方向键没有「往右就是右边那个点」的自然对应（力导向布局还会自己漂移），
        // 所以不按屏幕位置走，按数据本身的顺序走——也就是这本书从前到后的片段顺序。
        const all = circles.nodes();
        const current = all.indexOf(event.currentTarget);
        let next = null;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = current + 1;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = current - 1;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = all.length - 1;
        if (next === null) return;
        event.preventDefault();
        if (next < 0 || next >= all.length) return;
        all.forEach(node => node.setAttribute('tabindex', '-1'));
        all[next].setAttribute('tabindex', '0');
        all[next].focus();
    });

    // 四本书合计两百多个片段点，每个都能 Tab 到的话，键盘用户得按两百多次才走得出星系；
    // 整片星系只留一个 Tab 停靠点（第一个点），其余靠上面的方向键。
    circles.attr("tabindex", (d, i) => (i === 0 ? 0 : -1));

    // 系统要求「减少动态效果」时，不播这场收敛动画：先把力导向在内存里算完，
    // 停掉，再一次性画出来。注意 tick() 不触发 "tick" 事件，所以算完要手动调一次
    // ticked()，否则屏幕上是一片空白。
    if (prefersReducedMotion()) {
        galaxySimulation.tick(120);
        galaxySimulation.stop();
        ticked();
    }

    function ticked() {
        circles
            .attr("cx", d => d.x)
            .attr("cy", d => d.y);
        // 顺手记下落点，供下次进入时接着算（用户拖动后的位置也在这里被记下来）。
        // 复用同一个对象，不然 200 多个点乘以上百次迭代会白白造两万多个临时对象。
        allNodes.forEach(d => {
            const slot = galaxyPositions.get(d.id);
            if (slot) { slot.x = d.x; slot.y = d.y; }
            else galaxyPositions.set(d.id, { x: d.x, y: d.y });
        });
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
                // 关键词是英文（the / his / of 这类功能词）。不标 lang，读屏会拿中文音库
                // 逐字母去念；标了才会切到英文音库。只标这一个 span——下面那个「无关键词」
                // 的中文 span 不能跟着被标成英文。
                span.lang = 'en';
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
    const excerpt = d.extendedPreview || d.preview || '';
    if (textContainer) {
        textContainer.textContent = excerpt || "暂无详细文本内容...";
        // 有摘录时这段是英文原文，要标 lang 让读屏换英文音库；没有摘录时容器里放的是
        // 中文兜底文案，那就得把 lang 摘掉——元素是复用的，上一本书留下的 lang="en"
        // 会让这句中文也被按英文念。
        if (excerpt) textContainer.lang = 'en';
        else textContainer.removeAttribute('lang');
    }

    // 说清「这是摘录，不是全文」。字数按真正显示出来的字符算（_preview 会补省略号，
    // 那三个点不是原文），不写死 1200——老数据（只有 functionWords 带 extended_preview）
    // 走到这里时拿到的是 150 字符，写死就会变成另一句假话。
    const noteEl = document.getElementById('modal-text-note');
    if (noteEl) {
        const shown = excerptCharCount(excerpt);
        const wc = Number(d.wordCount);
        if (Number.isFinite(wc) && wc > 0) {
            // 英文平均一个词连同后随空格约 6 个字符，只用来给一个数量级感受
            const pct = Math.max(1, Math.round(shown / (wc * 6) * 100));
            noteEl.textContent = `本片段共约 ${wc.toLocaleString('en-US')} 个英文单词，`
                + `此处显示开头 ${shown} 个字符（约占 ${pct}%），不是全文。`;
        } else {
            noteEl.textContent = `此处显示片段开头的 ${shown} 个字符，不是全文。`;
        }
    }

    const modalCopyBtn = document.getElementById('modal-copy-btn');
    if (modalCopyBtn) {
        if (excerpt) {
            modalCopyBtn.dataset.copyIdx = registerCopySource(excerpt);
            modalCopyBtn.textContent = `⧉ 复制这段摘录（${excerptCharCount(excerpt)} 字符）`;
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
function trapFocusWithin(modal, event) {
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

function trapModalFocus(event) {
    trapFocusWithin(document.getElementById('galaxy-modal'), event);
}

function trapShelfModalFocus(event) {
    trapFocusWithin(document.getElementById('shelf-modal'), event);
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

    // 「书架编号」弹窗：点遮罩关闭、Esc 关闭、复制编号、切换书架
    const shelfModal = document.getElementById('shelf-modal');
    if (shelfModal) {
        shelfModal.addEventListener('click', function(e) {
            if (e.target === this) closeShelfModal();
        });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && shelfModal.getAttribute('aria-hidden') === 'false') {
                closeShelfModal();
            }
        });
        const copyBtn = document.getElementById('shelf-code-copy');
        if (copyBtn) {
            copyBtn.addEventListener('click', function() {
                // 编号还没到手（接口失败等）时按钮上本来就没东西可复制，别去闪一句错的提示
                if (!currentShelfCode) return;
                copyTextToClipboard(currentShelfCode, copyBtn, '✓ 已复制');
            });
        }
        const claimBtn = document.getElementById('shelf-code-claim');
        if (claimBtn) claimBtn.addEventListener('click', claimShelfCode);
        const input = document.getElementById('shelf-code-input');
        if (input) {
            input.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    claimShelfCode();
                }
            });
        }
    }

    // 文本雨按钮避让吸顶页签条：滚动、窗口尺寸、以及页面高度的变化都要重算一次。
    syncMatrixBtnDodge();
    window.addEventListener('scroll', scheduleMatrixBtnDodge, { passive: true });
    window.addEventListener('resize', scheduleMatrixBtnDodge);
    // 字体/图片到位后工具区高度还会再变一次，量早了会算在错的位置上。
    window.addEventListener('load', scheduleMatrixBtnDodge);
    if (typeof ResizeObserver === 'function') {
        // 页签条上方那一片（选书 chip 换行、快速开始横幅收起、书单变长…）一变高变矮，
        // 就推着页签条在文档里上下移动，body 的高度跟着变——盯 body 就覆盖得到。
        new ResizeObserver(scheduleMatrixBtnDodge).observe(document.body);
    }
});

window.openShelfModal = openShelfModal;
window.closeShelfModal = closeShelfModal;

window.restartGalaxy = function() {
    // 这个按钮承诺的是「重新布局」，所以要先丢掉上一轮的落点缓存——
    // 留着的话力导向会从上一次的稳态起步，几乎不动，按钮看起来失灵。
    galaxyPositions.clear();
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

    // 「区域平均」＋「平均句长」会读成「区域平均平均句长」：去掉标签自己的前导「平均」
    const hudMetricLabel = String(metricLabel || '').replace(/^平均/, '');
    // 书名统一走 getBookDisplayName（别处都显示《野性的呼唤》，这里原来显示
    // 截断的原始英文 key），截断交给已有的 truncateText，别硬切 15 个字
    const hudBookName = truncateText(getBookDisplayName(analysisData.dominantBook), 18);

    let html = `
        <div class="hud-row">
            <span class="hud-label">主要来自:</span>
            <span class="hud-value" style="color:#2f2a23">${escapeHtml(hudBookName)}</span>
        </div>
        <div class="hud-bar-bg" title="这本书占比 ${analysisData.dominanceRate.toFixed(0)}%">
            <div class="hud-bar-fill" style="width: ${analysisData.dominanceRate}%;"></div>
        </div>
        <div class="hud-row" style="margin-top:8px;">
            <span class="hud-label">区域平均${escapeHtml(hudMetricLabel)}:</span>
            <span class="hud-value" style="color:#b5472f">${formatMetric(analysisData.avgMetric)}</span>
        </div>
        <div class="hud-row" style="margin-top:8px;">
            <span class="hud-label">共同关键词:</span>
        </div>
        <div class="hud-tags">
            ${analysisData.topKeywords.map(k => `<span class="hud-tag" lang="en">${k}</span>`).join('')}
        </div>
        <div style="margin-top:10px; padding-top:5px; border-top:1px dashed rgba(46, 42, 36, 0.12); font-size:10px; color:#6b6254;">
            * 挨得近只说明高频小词的用法相近，不代表内容或水平相似。
        </div>
    `;

    content.innerHTML = html;
}

// ==========================================
// ⋮ 黑客帝国文本雨 (Matrix Keyword Rain)
// ==========================================

let matrixInterval = null;
let isMatrixOn = false;
// 停止时要把画布擦干净，但得等那层淡出走完，所以是延时 1 秒才动手。
// 这 1 秒里用户要是又点了「开始」，这个待执行的清除会落在**新的** interval 上，
// 把刚起来的雨冻住——所以把计时器存下来，重新开始时先撤掉它。
let matrixStopTimer = null;
// 换窗口大小时要按新宽度补/删列。用命名函数保存，重启时先把上一次的摘掉，
// 免得反复开关堆出一串监听器（旧写法用 window.onresize = 赋值，虽然不会叠加，
// 但它只改画布尺寸、不重算列数，拉宽后右边会空一条）。
let matrixResizeHandler = null;

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
    const makeDrop = () => ({
        y: Math.random() * -60,
        speed: 0.25 + Math.random() * 0.6,
        word: words[Math.floor(Math.random() * words.length)],
        color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
        opacity: 0.12 + Math.random() * 0.45
    });

    const drops = [];
    for (let i = 0; i < columns; i++) {
        drops[i] = makeDrop();
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

    if (matrixStopTimer) {
        clearTimeout(matrixStopTimer);
        matrixStopTimer = null;
    }
    if (matrixInterval) clearInterval(matrixInterval);
    matrixInterval = setInterval(draw, 50);

    if (matrixResizeHandler) window.removeEventListener('resize', matrixResizeHandler);
    matrixResizeHandler = () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        // 列数组是按旧宽度建的：拉宽后右边空一条，收窄则有一截画在画布外。
        // 按新宽度补/删列，已经在下的雨滴原样留着（它们下一帧会落到新的 x 上）。
        const nextColumns = Math.max(1, Math.floor(canvas.width / fontSize));
        while (drops.length < nextColumns) drops.push(makeDrop());
        if (drops.length > nextColumns) drops.length = nextColumns;
    };
    window.addEventListener('resize', matrixResizeHandler);
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

        matrixStopTimer = setTimeout(() => {
            matrixStopTimer = null;
            if (matrixInterval) {
                clearInterval(matrixInterval);
                matrixInterval = null;
            }
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (matrixResizeHandler) {
                window.removeEventListener('resize', matrixResizeHandler);
                matrixResizeHandler = null;
            }
        }, 1000);
    }
}

function toggleMatrixRain() {
    setMatrixRain(!isMatrixOn);
}

// —— 文本雨悬浮按钮给吸顶页签条让位 ——
// 手机上（≤560px）这个按钮钉在右下角，页签条还没滚到吸顶位置、恰好落进视口底部那一段时
// 两者会叠上：窗口 512×800（视口实测 512×702）下按钮在 662–690，压着「全书对比」页签的
// 682–719，`elementFromPoint` 在页签右上角命中的是按钮——那一下点击就被文本雨吃掉了。
// 病根是层叠上下文，不是 z-index 大小：.container 带 backdrop-filter（配上 position:relative;
// z-index:1），整棵子树在根上下文里只算 z-index 1——页签条自己的 z-index:30 根本出不去，
// 按钮只要在它上面（20 也好 9999 也好）就永远赢。既然比不出高下，就几何让位：
// 两者矩形相交时把按钮抬到页签条上沿之上，不相交就还原。
// 桌面档按钮钉在右上角（top:20px），跟页签条不在一条线上；两档靠 CSS 里的
// --anchored-bottom 分开（只有 ≤560px 那条规则给它赋值）。**不能**拿
// getComputedStyle(btn).top 来判断：对定位元素浏览器返回的是算好的像素值
// （实测返回 "662px" 而不是 "auto"），那样永远会走进桌面分支。
function matrixBtnAnchoredBottom() {
    const btn = document.getElementById('btn-matrix');
    if (!btn) return null;
    const v = parseFloat(getComputedStyle(btn).getPropertyValue('--anchored-bottom'));
    return isFinite(v) ? v : null;
}

let matrixBtnDodgeRaf = 0;

function syncMatrixBtnDodge() {
    matrixBtnDodgeRaf = 0;
    const btn = document.getElementById('btn-matrix');
    const nav = document.querySelector('.tab-navigation');
    if (!btn || !nav) return;

    const rest = matrixBtnAnchoredBottom();
    if (rest === null) {
        // 桌面档：内联的 bottom 必须摘干净——top 与 bottom 同时有值、高度又是 auto 时，
        // 盒子会被拉伸成从上沿到下沿的长条，而不是保持一颗药丸。
        if (btn.style.bottom) btn.style.bottom = '';
        return;
    }

    // 判断只用「页签条的矩形」＋「按钮不躲时该在的位置」，刻意不读按钮当前的矩形：
    // 否则抬起后不相交 → 还原 → 又相交 → 再抬起，会自激成抖动。
    const vh = window.innerHeight;
    const h = btn.offsetHeight;
    const restBottomEdge = vh - rest;      // 不躲时按钮下沿的 y
    const restTop = restBottomEdge - h;    // 不躲时按钮上沿的 y
    const bar = nav.getBoundingClientRect();

    let next = rest;
    if (bar.bottom > restTop && bar.top < restBottomEdge) {
        // 抬到页签条上沿之上 12px；视口极矮时再夹一下，别把按钮顶出屏幕。
        next = Math.min(Math.max(rest, vh - bar.top + 12), Math.max(0, vh - h - 4));
    }

    const cur = parseFloat(btn.style.bottom);
    if (!(isFinite(cur) && Math.abs(cur - next) < 0.5)) btn.style.bottom = next + 'px';
}

// rAF 合并：滚动时一帧里可能来好几个事件，量矩形只做一次。
function scheduleMatrixBtnDodge() {
    if (matrixBtnDodgeRaf) return;
    matrixBtnDodgeRaf = requestAnimationFrame(syncMatrixBtnDodge);
}

// 系统是否要求「减少动态效果」。原本只用来决定文本雨的默认开关，而页面里真正会动的
// 东西（d3 的过渡、星系的力导向收敛）一条都没走这个判断——用户在系统里关了动效，
// 打开这里照样满屏飞。下面这个函数给所有 d3 过渡用：要减少动效时把时长压成 0
// （瞬时到位，不是不动：不动的话柱状图会停在上一次的旧高度上）。
function prefersReducedMotion() {
    try {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
        return false;
    }
}

function motionDuration(ms) {
    return prefersReducedMotion() ? 0 : ms;
}