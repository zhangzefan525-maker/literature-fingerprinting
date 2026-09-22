# src/projection.py
"""
共享功能词投影模型
==================
跨书比较的前提是：所有书落在同一个坐标基底上。做法是——
1. 数据生成阶段把内置示例书的所有文本块合起来，只拟合一次 2 维 PCA；
2. 模型连同全局坐标范围一起写入 data/processed/pca_model.json；
3. 之后无论是内置书还是用户上传的书，都只用这个模型做投影，不再重新拟合。

因此同一段文字在任何时候、任何机器上都落在同一位置，
分享出去的链接与导出的图才长期有效。
"""

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

MODEL_VERSION = 1
MODEL_PATH = Path(__file__).resolve().parents[1] / "data" / "processed" / "pca_model.json"


def compute_model_id(model):
    """给模型算一个短指纹，用于在元数据/导出文件里标注「这批坐标出自哪个模型」。"""
    payload = json.dumps(
        {
            "version": MODEL_VERSION,
            "vocabulary": list(model.get("vocabulary") or []),
            "components": [
                [round(float(v), 6) for v in row] for row in (model.get("components") or [])
            ],
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return "pca-" + hashlib.sha1(payload.encode("utf-8")).hexdigest()[:12]


def axis_labels(model):
    """
    用每个主成分载荷最高的功能词生成一句白话说明，
    让不熟悉统计的研究者也能大致读懂横纵轴在区分什么。

    措辞注意：矩阵按行归一化过，所以是「占比更高」，不是「出现得更多」。
    """
    vocabulary = list(model.get("vocabulary") or [])
    components = model.get("components") or []
    labels = []
    for i, row in enumerate(components[:2]):
        # 退化模型（所有块用法完全一样）的载荷全是 0，硬说「哪几个词占比高」是编的
        if not any(abs(value) > 0 for value in row):
            continue
        order = sorted(range(len(row)), key=lambda j: -abs(row[j]))[:4]
        words = [vocabulary[j] for j in order if 0 <= j < len(vocabulary)]
        if not words:
            continue
        axis = "横轴" if i == 0 else "纵轴"
        direction = "右" if i == 0 else "上"
        labels.append(
            f"{axis}越靠{direction}，" + " / ".join(words) + " 这类小词在整段里占的比例越高"
        )
    return labels


def axis_extent(coords):
    """坐标范围（供前端固定坐标系，避免切换选书时点来回跳）。"""
    xs = [c["x"] for c in coords] or [0.0]
    ys = [c["y"] for c in coords] or [0.0]
    return {"x": [min(xs), max(xs)], "y": [min(ys), max(ys)]}


def build_model(matrix, vocabulary, fitted_on=None):
    """在矩阵上拟合共享模型，并把词表、解释方差、轴说明一并装进模型字典。"""
    from src.metrics import fit_pca_projection

    model = fit_pca_projection(matrix)
    model.update(
        {
            "version": MODEL_VERSION,
            "vocabulary": list(vocabulary),
            "fittedOn": fitted_on or {},
            "fittedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
    )
    model["axisLabels"] = axis_labels(model)
    model["modelId"] = compute_model_id(model)
    return model


def save_model(model, path=None):
    """写入模型文件（紧凑格式：模型里有几百个浮点数，缩进会让文件大一圈）。"""
    target = Path(path or MODEL_PATH)
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8") as f:
        json.dump(model, f, ensure_ascii=False)
    return target


def load_model(path=None):
    """读取共享模型；文件不存在或损坏时返回 None（调用方回退单书 PCA）。"""
    target = Path(path or MODEL_PATH)
    if not target.exists():
        return None
    try:
        with open(target, "r", encoding="utf-8") as f:
            model = json.load(f)
    except Exception:
        return None
    if not isinstance(model, dict) or "components" not in model or "mean" not in model:
        return None
    model.setdefault("modelId", compute_model_id(model))
    return model


def projection_metadata(model, mode="shared"):
    """
    给单本书 metadata 用的投影说明，前端据此决定能不能跨书比较：
    mode = "shared"（同一个基底，可比）或 "perBook"（各自为政，不可比）。
    """
    if model is None:
        return {
            "mode": "perBook",
            "modelId": None,
            "axisLabels": [],
            "axisExtent": None,
            "explainedVarianceRatio": [],
        }
    return {
        "mode": mode,
        "modelId": model.get("modelId"),
        "axisLabels": model.get("axisLabels") or [],
        "axisExtent": model.get("axisExtent"),
        "explainedVarianceRatio": model.get("explainedVarianceRatio") or [],
    }
