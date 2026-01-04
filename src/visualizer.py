# C成员的绘图函数
import matplotlib.pyplot as plt
import seaborn as sns
import numpy as np
import math

def draw_heatmap(data_values, title):
    """
    绘制文学指纹热力图 (Literature Fingerprint Heatmap)
    
    Args:
        data_values (list): 包含每个文本块指标值的列表 (float)
        title (str): 图表的标题
    
    Returns:
        fig: Matplotlib Figure 对象
    """
    # 如果没有数据，返回空图
    if not data_values:
        fig, ax = plt.subplots()
        ax.text(0.5, 0.5, "No Data", ha='center', va='center')
        return fig

    # 1. 计算网格尺寸
    # 论文中通常将一维的文本块序列排列成二维网格
    # 这里的策略是让网格尽可能接近正方形，或者宽度略大于高度
    n = len(data_values)
    cols = math.ceil(math.sqrt(n))
    rows = math.ceil(n / cols)

    # 2. 将一维数据转换为二维矩阵
    # 填充 NaN 以适配矩阵形状，NaN 在热力图中会自动显示为背景色或白色
    padded_length = rows * cols
    padded_data = np.array(data_values + [np.nan] * (padded_length - n))
    matrix = padded_data.reshape(rows, cols)

    # 3. 绘图
    fig, ax = plt.subplots(figsize=(10, 8))
    
    # 使用 'RdBu' 颜色映射 (Red-Blue)。
    # 通常: Red (低值/负) -> White -> Blue (高值/正)
    # 论文中：蓝色代表句长较长(Twain)，红色代表句长较短(London)
    sns.heatmap(matrix, ax=ax, cmap='RdBu', 
                cbar=True,            # 显示颜色条
                square=True,          # 每个单元格为正方形
                xticklabels=False,    # 隐藏X轴刻度
                yticklabels=False,    # 隐藏Y轴刻度
                mask=np.isnan(matrix), # 遮罩 NaN 值
                linewidths=0.5, linecolor='white') # 增加白色网格线美化
    
    ax.set_title(title, fontsize=14)
    return fig
