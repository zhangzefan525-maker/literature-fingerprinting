# -*- coding: utf-8 -*-
"""作者归属（authorship attribution）：把「这本书像谁写的」变成一个能验的数字。

方法全部取自计量文体学里既有的做法，没有自拟公式：

  · 特征 —— 功能词的**相对用法**。每个 1 万词窗口的计数向量按行 L1 归一化，
    与项目其它地方同一口径（`metrics.function_word_matrix`）。
  · 距离 —— **Burrows' Delta**：把每本书的用法向量按词 z 标准化，
    两本书之间的 Delta = 各词 z 差值的**平均绝对值**。越小越像。
  · 聚类 —— **平均连接**（average linkage / UPGMA）层次聚类，纯 numpy 实现，
    不引入 scipy（本项目刻意不让分析路径依赖它）。
  · 验证 —— **留一书交叉验证**（藏起一本，用剩下几本当参照，看它离哪一本最近）
    加上**非重叠窗口的逐窗归属**（每 10 个窗口取 1 个：窗口步长 1000 词、
    窗口宽 1 万词，取第 0、10、20… 个正好互不重叠）。

**这个模块只读 `data/raw/*.txt`，不写盘、不改任何既有数值。** 不碰
`data/processed/` 下的文件，也不参与 `generate_data.py` 那条管线——所以既有的
三个指标与所有投影坐标，一个数都不会因为它而变。不写盘是**必须**的，不只是图省事：

  · `generate_data.py` 重算时会把 `data/processed/` 里不在它 keep 集合内的 `*.json`
    直接删掉，任何「顺手落个盘」的新文件下次重算就没了；
  · `api_server._load_corpus()` 在没有汇总文件时会按修改时间扫 `data/processed/*.json`，
    挑「第一个含 metadata 的」当一本书——多一个文件就多一分被误认成书的风险。

结果算在内存里、由接口下发；缓存交给调用方（`api_server._authorship_cache`）。

关于「作者是谁」：书名 → 作者写在 `BUILTIN_AUTHORS` 里，出处是各 txt 开头的
Project Gutenberg 头部（Title / Author）。**用户上传的书没有可靠的作者**，
不能替他们编一个，所以它们不参与这里任何一项计算。
"""

import numpy as np
from sklearn.feature_extraction.text import CountVectorizer

from src.data_loader import BLOCK_SIZE, OVERLAP, STEP, get_blocks, load_clean_text
from src.metrics import function_word_matrix

# 书名（小写、去首尾空格）→ (英式作者名, 中文作者名)
#
# 这四本是**故意两两同作者**的：吐温 1876/1884，伦敦 1903/1906。这不只是为了好看——
# 换一批互不相干的书，就只能看距离、没法验准不准；两两同作者才让「作者归属」
# 这件事有一个能对答案的基准。而「同一作家不同时期」也正是文学研究里最常做的一类对比。
BUILTIN_AUTHORS = {
    'the call of the wild': ('London, Jack', '杰克·伦敦'),
    'white fang': ('London, Jack', '杰克·伦敦'),
    'the adventures of tom sawyer': ('Twain, Mark', '马克·吐温'),
    'the adventures of huckleberry finn': ('Twain, Mark', '马克·吐温'),
}

# 逐窗归属时每隔几个窗口取一个。窗口步长 1000 词、宽 1 万词，取 10 个正好不重叠。
BLOCK_STRIDE = 10

# 词表敏感性实验用到的几档规模。None = 项目默认的 NLTK 英语停用词表。
SENSITIVITY_SIZES = (None, 50, 100, 200, 500)

DEFAULT_VOCAB_LABEL = 'NLTK 英语停用词'


def author_of(name):
    """书名 → (英式作者名, 中文作者名)；查不到（例如用户上传的书）返回 (None, None)。"""
    if not isinstance(name, str):
        return None, None
    return BUILTIN_AUTHORS.get(name.strip().lower(), (None, None))


# ---------------------------------------------------------------------------
# 一、把原始文本变成「每本书一组窗口矩阵」
# ---------------------------------------------------------------------------

def load_corpus_blocks(raw_dir, names=None):
    """
    读 `raw_dir` 下的 .txt，清洗、切窗口。

    Args:
        raw_dir: 存放 .txt 的目录（str 或 Path）
        names: 只读这几本；缺省读目录下全部 .txt，按文件名字典序

    Returns:
        (names, blocks_by_book, words_by_book)
        窗口数为 0 的书会被跳过——不足 1 万词的短文本本来就算不出指纹，
        留着它只会让后面每一步都要处理「这本是空的」。
    """
    from pathlib import Path

    raw = Path(raw_dir)
    if names is None:
        names = sorted(p.stem for p in raw.glob('*.txt'))

    blocks_by_book, words_by_book = {}, {}
    for name in names:
        path = raw / (name + '.txt')
        if not path.exists():
            continue
        text = load_clean_text(str(path))
        blocks = get_blocks(text)
        if not blocks:
            continue
        blocks_by_book[name] = blocks
        words_by_book[name] = len(text.split())
    return list(blocks_by_book.keys()), blocks_by_book, words_by_book


def book_matrices(blocks_by_book, vocabulary=None):
    """
    每本书 → (窗口矩阵, 平均用法向量)。

    平均用法向量 = 该书所有窗口的 L1 归一化向量的均值，也就是这本书的「用法画像」。
    先归一化再平均，和项目造 PCA 输入时是同一个道理：不做这一步，
    得到的会是「这本书有多长」而不是「这些词怎么用」。

    Args:
        blocks_by_book: {书名: 窗口列表}
        vocabulary: 功能词表；缺省用 NLTK 英语停用词（与项目其它地方一致）

    Returns:
        (mats, profiles, vocab)：窗口矩阵、用法向量、实际使用的列顺序
        取不到矩阵的书（一个功能词都没有）直接不出现在结果里
    """
    mats, profiles, vocab = {}, {}, []
    for name, blocks in blocks_by_book.items():
        matrix, cols = function_word_matrix(blocks, vocabulary)
        if matrix is None or matrix.shape[1] == 0:
            continue
        mats[name] = matrix
        profiles[name] = matrix.mean(axis=0)
        vocab = cols
    return mats, profiles, vocab


def corpus_top_words(blocks_by_book, n):
    """
    语料里出现最多的前 n 个词，用来做词表敏感性实验。

    刻意用 CountVectorizer 本身来数（默认 `token_pattern` + 小写化），不自己写一遍。
    自己写只要有一处与 `function_word_matrix` 对不上，「换个词表结论还成不成立」
    这个实验就失去意义了——它验证的本来就是这个口径稳不稳。

    Args:
        blocks_by_book: {书名: 窗口列表}
        n: 取前几个

    Returns:
        list[str]，按词频降序
    """
    corpus = [b for blocks in blocks_by_book.values() for b in blocks]
    if not corpus:
        return []
    vectorizer = CountVectorizer()
    counts = np.asarray(vectorizer.fit_transform(corpus).sum(axis=0)).ravel()
    names = vectorizer.get_feature_names_out()
    order = np.argsort(-counts, kind='stable')
    return [str(names[i]) for i in order[:n]]


# ---------------------------------------------------------------------------
# 二、Burrows' Delta
# ---------------------------------------------------------------------------

def standardize(profiles, reference_blocks):
    """
    以 `reference_blocks`（一批窗口的原始矩阵）为基准，把每本书的用法向量 z 标准化。

    两件事都在这里做，缺一不可：

      1) **只保留在参照语料里真正有差异的词**。标准差为 0 的词在所有书里用法相同，
         放进去只会把 Delta 整体压小、不带来任何分辨力，还会稀释真正有信号的那些词。
      2) **减均值、除标准差**。不标准化的话，`the` 这类高频词的量级会盖过一切，
         Delta 就退化成「谁用的 the 多」——这恰恰是作者归属里最经典的陷阱。

    Args:
        profiles: {书名: 一维用法向量（未标准化）}
        reference_blocks: 参照用的一批窗口矩阵

    Returns:
        (z, keep, mu, sd)
        z: {书名: 标准化后的向量}；keep: 保留列的布尔掩码；
        mu/sd: 参照语料在**保留列**上的均值与标准差（逐窗归属时要用）
    """
    mu_all = reference_blocks.mean(axis=0)
    sd_all = reference_blocks.std(axis=0)
    keep = sd_all > 0
    mu, sd = mu_all[keep], sd_all[keep]
    z = {name: (profile[keep] - mu) / sd for name, profile in profiles.items()}
    return z, keep, mu, sd


def _delta(za, zb):
    """Burrows' Delta：两个 z 向量逐词差值的平均绝对值。"""
    return float(np.abs(za - zb).mean())


def delta_matrix(mats, names, reference_names=None):
    """
    两两 Delta 距离矩阵。

    Args:
        mats: {书名: 窗口矩阵}
        names: 参与比较的书名，顺序即矩阵的行列顺序
        reference_names: 用哪些书定标准化基准；缺省用 names 全部

    Returns:
        (matrix, z, keep)：matrix 是 Python 浮点数的二维列表，对角线恒为 0.0
    """
    reference_names = list(names) if reference_names is None else list(reference_names)
    reference = np.vstack([mats[n] for n in reference_names])

    profiles = {n: mats[n].mean(axis=0) for n in names}
    z, keep, _mu, _sd = standardize(profiles, reference)

    size = len(names)
    matrix = [[0.0] * size for _ in range(size)]
    for i in range(size):
        for j in range(i + 1, size):
            d = _delta(z[names[i]], z[names[j]])
            matrix[i][j] = d
            matrix[j][i] = d
    return matrix, z, keep


def _nearest(z_target, z_reference, candidates):
    """
    在 candidates 里找与 z_target 最近的。

    Returns:
        (winner, distance, ranked)：第一名、它的距离、以及按距离升序的完整榜单
        并列时按书名字典序定先后，保证同一批输入每次得出同一个结论。
    """
    ranked = sorted(((_delta(z_target, z_reference[name]), name) for name in candidates))
    distance, winner = ranked[0]
    return winner, distance, [(name, d) for d, name in ranked]


# ---------------------------------------------------------------------------
# 三、平均连接层次聚类（纯 numpy，不用 scipy）
# ---------------------------------------------------------------------------

def average_linkage(names, matrix):
    """
    平均连接（UPGMA）层次聚类。

    「平均连接」的意思是：两个簇之间的距离 = 两簇成员**两两距离的平均**。
    换成「最近的一对」（单连接）会让一条链把不相干的书串起来；
    「最远的一对」（全连接）又过度保守。文本聚类里常用的是平均连接。

    平局按「先遇到的先合并」定（见下面双重循环的严格小于），保证同一批输入
    每次跑出同一棵树——树的形状会被画出来、会被截图引用，不能每次开页面都不一样。

    Args:
        names: 叶子名字，顺序对应 matrix 的行列
        matrix: 两两距离矩阵

    Returns:
        list of dict，按发生顺序排列：
            {'id': 4, 'left': 0, 'right': 1, 'height': 0.81, 'size': 2, 'leaves': [...]}
        叶子 id 就是它在 names 里的下标；每次合并生成一个新 id（从 len(names) 起递增），
        `left`/`right` 指向两个被合并的簇的 id——前端据此画树。
    """
    distance = np.asarray(matrix, dtype=float)
    size = len(names)

    clusters = {i: [i] for i in range(size)}
    alive = list(range(size))
    merges = []
    next_id = size

    while len(alive) > 1:
        best_pair, best_d = None, None
        for a in range(len(alive)):
            for b in range(a + 1, len(alive)):
                i, j = alive[a], alive[b]
                d = float(np.mean([distance[x][y] for x in clusters[i] for y in clusters[j]]))
                if best_d is None or d < best_d:
                    best_d, best_pair = d, (i, j)

        i, j = best_pair
        merged = clusters[i] + clusters[j]
        merges.append({
            'id': next_id,
            'left': i,
            'right': j,
            'height': round(best_d, 6),
            'size': len(merged),
            'leaves': sorted(names[k] for k in merged),
        })
        clusters[next_id] = merged
        alive = [k for k in alive if k != i and k != j] + [next_id]
        next_id += 1

    return merges


def leaf_order(merges, names):
    """
    从左到右的叶子顺序：对最终那棵树做一次中序遍历。

    画树时按这个顺序竖着摆叶子，同一支的叶子自然相邻，不会出现「同一作者的两本
    被别的书隔开」这种图上看着别扭、还容易读错的情况。
    """
    if not merges:
        return list(names)

    children = {}
    for merge in merges:
        children[merge['id']] = (merge['left'], merge['right'])

    order = []

    def walk(node):
        if node in children:
            left, right = children[node]
            walk(left)
            walk(right)
        else:
            order.append(names[node])

    walk(merges[-1]['id'])
    return order


# ---------------------------------------------------------------------------
# 四、留一书交叉验证 + 逐窗归属
# ---------------------------------------------------------------------------

def leave_one_out(mats, names, stride=BLOCK_STRIDE):
    """
    留一书交叉验证：每次藏起一本，用剩下几本当参照，看藏起来这本离谁最近。

    判定单位是**书**而不是作者：先找最近的参照书，再取它的作者。这样「模型的判断」
    是一句读者能自己复核的话（「《白牙》离《野性的呼唤》最近」），而不是一个
    看不见摸不着的质心。两种写法在这里其实等价——到某位作者的距离取该作家作品的
    最小值，就是「他所有作品里最近的那本」——但说法上后者清楚得多。

    这里特意把**每一本的每一个距离都报出来**，而不是只给一个 ✓/✗：
    领先 0.30 的判对和领先 0.001 的判对，证据力完全不是一回事。

    Args:
        mats: {书名: 窗口矩阵}
        names: 参与的书名
        stride: 逐窗归属用的抽样间隔（只在同一接口里统一口径用，本函数不用）

    Returns:
        {'total': int, 'correct': int, 'rows': [...]}
    """
    usable = [n for n in names if n in mats]
    rows, correct, scored = [], 0, 0

    for held in usable:
        train = [n for n in usable if n != held]
        if not train:
            continue
        reference = np.vstack([mats[n] for n in train])
        profiles = {n: mats[n].mean(axis=0) for n in train + [held]}
        z, _keep, _mu, _sd = standardize(profiles, reference)

        winner, win_d, ranked = _nearest(z[held], z, train)
        true_author, true_author_zh = author_of(held)
        win_author, win_author_zh = author_of(winner)
        runner_up_book, runner_up_d = ranked[1] if len(ranked) > 1 else (None, None)

        hit = true_author is not None and win_author == true_author
        scored += 1
        correct += 1 if hit else 0
        rows.append({
            'book': held,
            'author': true_author,
            'authorZh': true_author_zh,
            'predictedBook': winner,
            'predictedAuthor': win_author,
            'predictedAuthorZh': win_author_zh,
            'correct': bool(hit),
            'distances': {n: round(d, 6) for n, d in ranked},
            'runnerUpBook': runner_up_book,
            'margin': round(runner_up_d - win_d, 6) if runner_up_d is not None else None,
        })

    return {'total': scored, 'correct': correct, 'rows': rows}


def block_attribution(mats, names, stride=BLOCK_STRIDE):
    """
    逐窗归属：把每本书里**互不重叠**的那些窗口，各自判给最近的参照书，再看作者对不对。

    取 stride=10 是因为窗口步长 1000 词、宽 1 万词：相邻窗口重叠 90%，要是把 28 个
    窗口全算进来，等于把同一批 1 万词数了十遍，准确率会虚高得离谱。取第 0、10、20…
    个则两两不重叠，这时「28 个窗口判对 24 个」才是一句能站住的话。

    每个窗口的 z 都拿**其余几本**的参照系来算（和留一书同一个口径）：被判的那本
    不参与定标，否则就是拿答案对答案。实测这一条在这四本书上不改变结论——换成
    全部四本一起定标，逐窗仍然是 24/28、每一本的判对数也逐一相同（见
    tests/test_authorship.py 的 test_block_attribution_is_leave_one_out）；但口径
    不因为「这次没差」就可以不讲，换一套语料它就可能有差。

    Returns:
        {'total', 'correct', 'accuracy', 'stride', 'perBook': [...]}
    """
    usable = [n for n in names if n in mats]
    per_book, total, correct = [], 0, 0

    for held in usable:
        train = [n for n in usable if n != held]
        if not train:
            continue
        reference = np.vstack([mats[n] for n in train])
        profiles = {n: mats[n].mean(axis=0) for n in train}
        z_ref, keep, mu, sd = standardize(profiles, reference)

        windows = mats[held][::stride][:, keep]
        true_author = author_of(held)[0]

        book_total = book_correct = 0
        for row in windows:
            winner, _d, _ranked = _nearest((row - mu) / sd, z_ref, train)
            book_total += 1
            book_correct += 1 if (true_author is not None
                                  and author_of(winner)[0] == true_author) else 0

        per_book.append({'book': held, 'total': book_total, 'correct': book_correct})
        total += book_total
        correct += book_correct

    return {
        'total': total,
        'correct': correct,
        'accuracy': round(correct / total, 6) if total else None,
        'stride': stride,
        'perBook': per_book,
    }


# ---------------------------------------------------------------------------
# 五、词表敏感性
# ---------------------------------------------------------------------------

def sensitivity(blocks_by_book, names, sizes=SENSITIVITY_SIZES, stride=BLOCK_STRIDE):
    """
    换几套功能词表，把留一书与逐窗归属各重跑一遍。

    这一节是整个页签里最要紧的一块：**它回答的是「你这个结论是不是挑参数挑出来的」。**
    只报一套词表的结果，读者没法知道结论有多硬；把默认停用词表（198 词）和语料高频
    前 50 / 100 / 200 / 500 词摆在一起，若结论原地不动，「不依赖参数选择」就是一句
    被验过的话，而不是一句自我评价。

    Args:
        blocks_by_book: {书名: 窗口列表}
        names: 参与的书名
        sizes: 几档规模；None 表示默认停用词表
        stride: 逐窗归属的抽样间隔

    Returns:
        list of dict，每档一行：词表规模、实际参与比较的词数（去掉无差异的词之后）、
        两项准确率。算不出矩阵的那档直接跳过，不塞一行假的。
    """
    usable = [n for n in names if n in blocks_by_book]
    out = []
    for size in sizes:
        if size is None:
            label, vocabulary = DEFAULT_VOCAB_LABEL, None
        else:
            vocabulary = corpus_top_words(blocks_by_book, size)
            label = f'语料高频前 {size} 词'
            if not vocabulary:
                continue

        mats, _profiles, vocab = book_matrices(blocks_by_book, vocabulary)
        included = [n for n in usable if n in mats]
        if len(included) < 2:
            continue

        _matrix, _z, keep = delta_matrix(mats, included)
        loo = leave_one_out(mats, included, stride)
        blocks = block_attribution(mats, included, stride)

        out.append({
            'label': label,
            'vocabSize': len(vocab),
            'comparableWords': int(keep.sum()),
            'leaveOneOutCorrect': loo['correct'],
            'leaveOneOutTotal': loo['total'],
            'blockCorrect': blocks['correct'],
            'blockTotal': blocks['total'],
            'blockAccuracy': blocks['accuracy'],
        })
    return out


# ---------------------------------------------------------------------------
# 六、对外的总入口
# ---------------------------------------------------------------------------

def analyze(raw_dir, stride=BLOCK_STRIDE, sizes=SENSITIVITY_SIZES):
    """
    跑完整套作者归属分析，返回可直接 JSON 化的结构。

    哪一步都只读、不写盘，重复调用不会改变任何既有文件。

    Args:
        raw_dir: `data/raw` 目录
        stride: 逐窗归属的抽样间隔
        sizes: 词表敏感性实验的几档规模

    Returns:
        dict。语料里不足两本可用的书时返回 `{'enough': False, ...}`——
        由调用方决定怎么跟读者说，不要在算不出来的地方硬画一张空图。
    """
    names, blocks_by_book, words_by_book = load_corpus_blocks(raw_dir)

    mats, _profiles, vocab = book_matrices(blocks_by_book)
    names = [n for n in names if n in mats]

    if len(names) < 2 or len({author_of(n)[0] for n in names} - {None}) < 2:
        return {
            'enough': False,
            'books': [],
            'message': '语料里至少要有两本书、且分属两位以上作者，才算得出作者归属。',
        }

    matrix, _z, keep = delta_matrix(mats, names)
    merges = average_linkage(names, matrix)
    loo = leave_one_out(mats, names, stride)
    blocks = block_attribution(mats, names, stride)
    sens = sensitivity(blocks_by_book, names, sizes, stride)

    authors = {}
    for name in names:
        en, zh = author_of(name)
        if en is None:
            continue
        authors.setdefault(en, {'name': en, 'nameZh': zh, 'books': []})['books'].append(name)

    books = [{
        'name': name,
        'author': author_of(name)[0],
        'authorZh': author_of(name)[1],
        'blocks': len(blocks_by_book[name]),
        'words': words_by_book.get(name, 0),
    } for name in names]

    return {
        'enough': True,
        'meta': {
            'blockSize': BLOCK_SIZE,
            'overlap': OVERLAP,
            'step': STEP,
            'stride': stride,
            'vocabSize': len(vocab),
            'comparableWords': int(keep.sum()),
            'vocabulary': DEFAULT_VOCAB_LABEL,
            'distance': "Burrows' Delta（逐词 z 差值的平均绝对值，越小越像）",
            'linkage': '平均连接（UPGMA）',
            'standardizedOn': '参与比较的全部窗口的均值和标准差',
        },
        'books': books,
        'authors': list(authors.values()),
        'distance': {'names': names, 'matrix': matrix},
        'clustering': {'merges': merges, 'leaves': names, 'leafOrder': leaf_order(merges, names)},
        'leaveOneOut': loo,
        'blockAttribution': blocks,
        'sensitivity': sens,
    }
