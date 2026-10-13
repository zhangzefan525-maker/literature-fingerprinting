# src/analysis_utils.py
"""
纯数值分析工具
================
趋势、异常片段、序列相关等分析，只用标准库 + numpy 实现，
**不引入 matplotlib / pandas / scipy**。

这样它可以被 HTTP 接口（api_server.py 的只读分析接口）直接调用，
不必为了返回几个数字就把绘图库加载起来。
"""

import math


def _clean(values):
    """只保留可用数值，并按原顺序返回。"""
    cleaned = []
    for value in values or []:
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(number):
            cleaned.append(number)
    return cleaned


def summarize(values):
    """基础统计量。样本不足时返回的字段为 None，而不是编一个值。"""
    data = _clean(values)
    if not data:
        return {"count": 0, "mean": None, "median": None, "std": None,
                "min": None, "max": None, "cv": None}

    count = len(data)
    mean = sum(data) / count
    ordered = sorted(data)
    middle = count // 2
    median = ordered[middle] if count % 2 else (ordered[middle - 1] + ordered[middle]) / 2
    variance = sum((value - mean) ** 2 for value in data) / count

    return {
        "count": count,
        "mean": mean,
        "median": median,
        "std": math.sqrt(variance),
        "min": ordered[0],
        "max": ordered[-1],
        "cv": (math.sqrt(variance) / mean) if mean else None,
    }


def linear_trend(values):
    """
    趋势：最小二乘拟合的斜率，以及它与数据波动相比算不算明显。

    用「斜率 × 数据长度」再除以标准差得到 strength——等价于皮尔逊相关的绝对值，
    但不需要 scipy 的 t 分布，读起来也更直观：越接近 1，越像单调上升/下降。
    """
    data = _clean(values)
    count = len(data)
    if count < 3:
        # 键要和下面正常路径**完全一致**（第五十二批）：这里原来少 slopePercent 与
        # turningPoints 两个。今天没有消费者所以谁也看不见，但下一个读
        # trend["turningPoints"] 的人会拿到 KeyError——而且只会**在片段数不足 3 的书上**炸。
        return {
            "slope": None,
            "slopePercent": None,
            "strength": None,
            "direction": "unknown",
            "volatility": None,
            "turningPoints": None,
        }

    xs = list(range(count))
    mean_x = sum(xs) / count
    mean_y = sum(data) / count
    sxx = sum((x - mean_x) ** 2 for x in xs)
    sxy = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, data))
    slope = sxy / sxx if sxx else 0.0
    mean_abs = mean_y if mean_y else 1.0
    syy = sum((y - mean_y) ** 2 for y in data)

    if syy > 0:
        correlation = sxy / math.sqrt(sxx * syy)
    else:
        correlation = 0.0
    strength = abs(correlation)

    diffs = [data[i + 1] - data[i] for i in range(count - 1)]
    volatility = sum(abs(d) for d in diffs) / len(diffs) if diffs else 0.0

    if strength < 0.3:
        direction = "flat"
    else:
        direction = "up" if slope > 0 else "down"

    return {
        "slope": slope,
        "slopePercent": (slope / mean_abs) * 100,  # 每前进一个片段，变化了平均水平的百分之几
        "strength": strength,
        "direction": direction,
        "volatility": volatility,
        "turningPoints": sum(1 for i in range(1, len(diffs)) if diffs[i] * diffs[i - 1] < 0),
    }


def detect_anomalies(values, z_threshold=2.0, max_items=8):
    """
    异常片段：两种口径都算，取并集。

    - z 分数：偏离均值超过 2 个标准差；
    - IQR：超出四分位距 1.5 倍以外的点。

    两种方法的假设不同（前者怕极端值，后者怕偏态分布），一起给出更稳妥；
    返回时按偏离程度排序，最多 max_items 条，避免把整本书都列出来。
    """
    data = _clean(values)
    count = len(data)
    if count < 5:
        # counts 的键也要和下面正常路径一致（第五十二批）：这里原来少一个 total。
        # 正常路径那句注释写明了 total 是给谁用的（「一共找出多少个」，前端读它才
        # 说得出「这里列了 8 个、其实有 20 个」）——少一个键就会让读它的人拿到
        # KeyError，而且只在片段不足 5 条时炸。
        return {"items": [], "zThreshold": z_threshold,
                "counts": {"z": 0, "iqr": 0, "total": 0}}

    mean = sum(data) / count
    variance = sum((value - mean) ** 2 for value in data) / count
    std = math.sqrt(variance)

    ordered = sorted(data)
    q1 = ordered[int(0.25 * (count - 1))]
    q3 = ordered[int(0.75 * (count - 1))]
    iqr = q3 - q1
    lower = q1 - 1.5 * iqr
    upper = q3 + 1.5 * iqr

    scored = []
    z_indexes = set()
    iqr_indexes = set()
    for index, value in enumerate(data):
        z = (value - mean) / std if std else 0.0
        is_z = abs(z) > z_threshold
        is_iqr = value < lower or value > upper
        if is_z:
            z_indexes.add(index)
        if is_iqr:
            iqr_indexes.add(index)
        if is_z or is_iqr:
            scored.append({
                "index": index,
                "value": value,
                "zScore": z,
                "byZScore": is_z,
                "byIQR": is_iqr,
                "deviation": (abs(z) if is_z else 0.0) + (1.0 if is_iqr else 0.0),
            })

    scored.sort(key=lambda item: -item["deviation"])
    return {
        "items": scored[:max_items],
        "zThreshold": z_threshold,
        # counts 里多一个 total：items 被截断到 max_items，但「一共找出多少个」必须带出去，
        # 否则前端没法说清「这里列了 8 个、这本书其实有 20 个」，读者会把这 8 条当成全集。
        # 只多报一个数，不参与任何计算，指标口径一个字没动。
        "counts": {"z": len(z_indexes), "iqr": len(iqr_indexes), "total": len(scored)},
    }


def analyze_series(values):
    """一次性给出统计量、趋势与异常片段（接口与分析报告共用）。"""
    return {
        "summary": summarize(values),
        "trend": linear_trend(values),
        "anomalies": detect_anomalies(values),
    }
