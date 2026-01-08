# src/analyzer.py
"""
指纹图分析模块 - 对生成的文学指纹进行统计分析
"""
import numpy as np
import pandas as pd
from scipy import stats
from typing import Dict, List, Tuple
import matplotlib.pyplot as plt
import matplotlib

# +++ 设置中文字体，防止中文显示为方格 +++
try:
    # 尝试使用系统中常见的中文字体
    plt.rcParams['font.sans-serif'] = ['SimHei', 'Microsoft YaHei', 'DejaVu Sans']
    plt.rcParams['axes.unicode_minus'] = False  # 正确显示负号
    matplotlib.font_manager.fontManager.addfont("SimHei.ttf")
except:
    # 如果找不到中文字体，使用默认字体
    pass

class FingerprintAnalyzer:
    """
    文学指纹分析器
    对生成的指纹图进行统计分析，提供洞察和模式检测
    """
    
    def __init__(self):
        self.stats_cache = {}
        
    def analyze_single_fingerprint(self, values: List[float], book_name: str, metric_name: str) -> Dict:
        """
        分析单个指纹图
        """
        if not values:
            return {}
        
        values_array = np.array(values)
        
        # 基础统计分析
        stats_dict = {
            'book_name': book_name,
            'metric_name': metric_name,
            'mean': float(np.mean(values_array)),
            'median': float(np.median(values_array)),
            'std': float(np.std(values_array)),
            'min': float(np.min(values_array)),
            'max': float(np.max(values_array)),
            'range': float(np.max(values_array) - np.min(values_array)),
            'cv': float(np.std(values_array) / np.mean(values_array)) if np.mean(values_array) != 0 else 0,
            'num_blocks': len(values_array)
        }
        
        # 趋势分析
        stats_dict.update(self._analyze_trends(values_array))
        
        # 异常值检测
        stats_dict.update(self._detect_anomalies(values_array))
        
        # 风格分类（基于指标）
        stats_dict['style_category'] = self._classify_style(values_array, metric_name)
        
        return stats_dict
    
    def _analyze_trends(self, values: np.ndarray) -> Dict:
        """分析时间趋势"""
        if len(values) < 2:
            return {}
        
        # 计算线性趋势
        x = np.arange(len(values))
        slope, intercept, r_value, p_value, std_err = stats.linregress(x, values)
        
        # 计算移动平均
        window_size = min(5, len(values) // 4)
        if window_size > 1:
            moving_avg = pd.Series(values).rolling(window=window_size, center=True).mean().values
            moving_std = pd.Series(values).rolling(window=window_size, center=True).std().values
        else:
            moving_avg = values
            moving_std = np.zeros_like(values)
        
        # 检测转折点（简单实现：基于一阶差分符号变化）
        diffs = np.diff(values)
        turning_points = np.sum(diffs[1:] * diffs[:-1] < 0)
        
        return {
            'trend_slope': float(slope),
            'trend_strength': float(abs(r_value)),  # R²值
            'trend_p_value': float(p_value),
            'turning_points': int(turning_points),
            'volatility': float(np.mean(np.abs(diffs))) if len(diffs) > 0 else 0
        }
    
    def _detect_anomalies(self, values: np.ndarray) -> Dict:
        """检测异常值"""
        if len(values) < 3:
            return {'anomalies': [], 'anomaly_count': 0}
        
        # 使用Z-score方法检测异常值
        z_scores = np.abs(stats.zscore(values))
        anomaly_threshold = 2.0
        anomalies = np.where(z_scores > anomaly_threshold)[0]
        
        # 使用IQR方法检测异常值
        Q1 = np.percentile(values, 25)
        Q3 = np.percentile(values, 75)
        IQR = Q3 - Q1
        iqr_anomalies = np.where((values < Q1 - 1.5 * IQR) | (values > Q3 + 1.5 * IQR))[0]
        
        return {
            'anomalies': anomalies.tolist(),
            'iqr_anomalies': iqr_anomalies.tolist(),
            'anomaly_count': len(anomalies),
            'iqr_anomaly_count': len(iqr_anomalies)
        }
    
    def _classify_style(self, values: np.ndarray, metric_name: str) -> str:
        """基于指标值进行风格分类"""
        mean_val = np.mean(values)
        cv_val = np.std(values) / mean_val if mean_val != 0 else 0
        
        style_parts = []
        
        if "Sentence Length" in metric_name:
            if mean_val < 15:
                style_parts.append("简洁短句风格")
            elif mean_val < 25:
                style_parts.append("中等句长风格")
            else:
                style_parts.append("复杂长句风格")
        elif "Simpson" in metric_name or "Vocabulary" in metric_name:
            if mean_val < 0.1:
                style_parts.append("词汇多样性高")
            elif mean_val < 0.2:
                style_parts.append("词汇多样性中等")
            else:
                style_parts.append("词汇多样性低")
        elif "Hapax" in metric_name or "Uniqueness" in metric_name:
            if mean_val < 50:
                style_parts.append("词汇重复度较高")
            elif mean_val < 100:
                style_parts.append("词汇使用均衡")
            else:
                style_parts.append("词汇独特性强")
        elif "PCA" in metric_name or "Function" in metric_name:
            if mean_val < 0:
                style_parts.append("虚词使用模式A")
            else:
                style_parts.append("虚词使用模式B")
        else:
            style_parts.append("需要进一步分析")
        
        # 添加波动性描述（使用更简洁的描述）
        if cv_val > 0.3:
            style_parts.append("波动性大")
        elif cv_val > 0.15:
            style_parts.append("中等波动")
        else:
            style_parts.append("风格稳定")
        
        # 使用中文竖线分隔，确保完整显示
        return " | ".join(style_parts)
    
    def compare_fingerprints(self, all_results: Dict) -> Dict:
        """
        比较多个指纹图
        """
        comparison = {
            'books': list(all_results.keys()),
            'comparison_metrics': {},
            'similarity_matrix': None
        }
        
        if len(all_results) < 2:
            return comparison
        
        # 计算每本书的基本统计量
        for book_name, data in all_results.items():
            comparison['comparison_metrics'][book_name] = {
                'mean': np.mean(data['values']),
                'std': np.std(data['values'])
            }
        
        # 计算相似性矩阵（基于相关系数）
        book_names = list(all_results.keys())
        n_books = len(book_names)
        similarity = np.zeros((n_books, n_books))
        
        for i in range(n_books):
            for j in range(n_books):
                if i != j and len(all_results[book_names[i]]['values']) > 1 and len(all_results[book_names[j]]['values']) > 1:
                    # 使用动态时间规整(DTW)或简单相关系数
                    # 这里使用简单相关系数，注意需要对齐长度
                    min_len = min(len(all_results[book_names[i]]['values']), 
                                  len(all_results[book_names[j]]['values']))
                    if min_len > 1:
                        corr = np.corrcoef(
                            all_results[book_names[i]]['values'][:min_len],
                            all_results[book_names[j]]['values'][:min_len]
                        )[0, 1]
                        similarity[i, j] = corr
                similarity[i, i] = 1.0
        
        comparison['similarity_matrix'] = similarity.tolist()
        
        # 检测可能的异常书籍（与其他书籍风格差异大）
        if n_books > 2:
            avg_similarities = np.mean(similarity, axis=1) - 1  # 减去自相似
            outlier_idx = np.argmin(avg_similarities)
            comparison['most_unique_book'] = book_names[outlier_idx]
            comparison['most_similar_pair'] = self._find_most_similar_pair(book_names, similarity)
        
        return comparison
    
    def _find_most_similar_pair(self, book_names: List[str], similarity: np.ndarray) -> Tuple:
        """找出最相似的书籍对"""
        max_sim = -1
        pair = (None, None)
        
        for i in range(len(book_names)):
            for j in range(i+1, len(book_names)):
                if similarity[i, j] > max_sim:
                    max_sim = similarity[i, j]
                    pair = (book_names[i], book_names[j])
        
        return pair
    
    def generate_analysis_report(self, all_books_results: Dict, metric_name: str) -> str:
        """
        生成分析报告（纯文本格式）
        """
        if not all_books_results:
            return "暂无数据进行分析。"
        
        report_lines = []
        report_lines.append("=" * 60)
        report_lines.append("📊 文学指纹分析报告")
        report_lines.append("=" * 60)
        report_lines.append(f"分析指标: {metric_name}")
        report_lines.append(f"分析书籍: {len(all_books_results)} 本")
        report_lines.append("")
        
        # 单个书籍分析
        for book_name, data in all_books_results.items():
            stats = self.analyze_single_fingerprint(data['values'], book_name, metric_name)
            
            if stats:
                # 缩短文件名显示
                short_name = book_name[:20] + "..." if len(book_name) > 20 else book_name
                report_lines.append(f"📖 书籍: {short_name}")
                report_lines.append(f"  风格分类: {stats.get('style_category', '未知')}")
                report_lines.append(f"  均值: {stats.get('mean', 0):.2f} ± {stats.get('std', 0):.2f}")
                report_lines.append(f"  范围: {stats.get('min', 0):.2f} - {stats.get('max', 0):.2f}")
                trend_slope = stats.get('trend_slope', 0)
                trend_desc = "上升" if trend_slope > 0.01 else "下降" if trend_slope < -0.01 else "平稳"
                report_lines.append(f"  趋势: {trend_desc} (斜率: {trend_slope:.4f})")
                report_lines.append(f"  波动性: {stats.get('volatility', 0):.4f}")
                report_lines.append(f"  异常值: {stats.get('anomaly_count', 0)} 个")
                report_lines.append("")
        
        # 多本书籍比较
        if len(all_books_results) > 1:
            report_lines.append("-" * 60)
            report_lines.append("🔄 跨书比较分析")
            report_lines.append("-" * 60)
            
            comparison = self.compare_fingerprints(all_books_results)
            
            # 找出风格最独特的书
            if 'most_unique_book' in comparison:
                unique_book = comparison['most_unique_book']
                short_unique = unique_book[:15] + "..." if len(unique_book) > 15 else unique_book
                report_lines.append(f"最独特的风格: {short_unique}")
            
            # 找出最相似的书
            if 'most_similar_pair' in comparison:
                book1, book2 = comparison['most_similar_pair']
                if book1 and book2:
                    short1 = book1[:12] + "..." if len(book1) > 12 else book1
                    short2 = book2[:12] + "..." if len(book2) > 12 else book2
                    report_lines.append(f"最相似的风格对: {short1} ↔ {short2}")
            
            report_lines.append("")
            
            # 添加Huckleberry Finn的特殊检测
            huck_keywords = ['huckleberry', 'finn', 'huck']
            for book_name in all_books_results.keys():
                book_lower = book_name.lower()
                if any(keyword in book_lower for keyword in huck_keywords):
                    report_lines.append("🎯 特殊发现: 检测到《哈克贝利·费恩历险记》")
                    report_lines.append("   根据Keim & Oelke (2007)的研究，此书风格异常:")
                    report_lines.append("   • 第一人称儿童视角")
                    report_lines.append("   • 大量口语方言使用")
                    report_lines.append("   • 非标准语法结构")
                    break
        
        report_lines.append("=" * 60)
        report_lines.append(f"分析完成: {pd.Timestamp.now().strftime('%Y-%m-%d %H:%M')}")
        
        return "\n".join(report_lines)
    
    def create_summary_visualization(self, all_books_results: Dict, metric_name: str):
        """
        创建汇总可视化图表
        """
        if not all_books_results:
            return None
        
        # 设置图表字体大小
        plt.rcParams.update({'font.size': 10})
        
        fig, axes = plt.subplots(2, 2, figsize=(12, 10))
        fig.suptitle(f'文学指纹综合分析 - {metric_name}', fontsize=14, fontweight='bold')
        
        book_names = list(all_books_results.keys())
        # 缩短显示名称
        short_names = [name[:15] + "..." if len(name) > 15 else name for name in book_names]
        colors = plt.cm.Set3(np.linspace(0, 1, len(book_names)))
        
        # 1. 均值比较条形图
        ax1 = axes[0, 0]
        means = [np.mean(data['values']) for data in all_books_results.values()]
        bars1 = ax1.barh(short_names, means, color=colors, height=0.6)
        ax1.set_xlabel('均值')
        ax1.set_title('各书指标均值比较')
        ax1.grid(True, alpha=0.3, axis='x')
        
        # 在条形末端添加数值标签
        for bar, mean_val in zip(bars1, means):
            ax1.text(bar.get_width() * 1.01, bar.get_y() + bar.get_height()/2,
                    f'{mean_val:.2f}', va='center', fontsize=8)
        
        # 2. 波动性比较条形图
        ax2 = axes[0, 1]
        stds = [np.std(data['values']) for data in all_books_results.values()]
        bars2 = ax2.barh(short_names, stds, color=colors, height=0.6)
        ax2.set_xlabel('标准差')
        ax2.set_title('各书指标波动性比较')
        ax2.grid(True, alpha=0.3, axis='x')
        
        for bar, std_val in zip(bars2, stds):
            ax2.text(bar.get_width() * 1.01, bar.get_y() + bar.get_height()/2,
                    f'{std_val:.2f}', va='center', fontsize=8)
        
        # 3. 箱线图比较
        ax3 = axes[1, 0]
        box_data = [data['values'] for data in all_books_results.values()]
        bp = ax3.boxplot(box_data, labels=short_names, patch_artist=True, widths=0.6)
        for patch, color in zip(bp['boxes'], colors):
            patch.set_facecolor(color)
            patch.set_alpha(0.7)
        ax3.set_ylabel('指标值')
        ax3.set_title('分布箱线图比较')
        ax3.tick_params(axis='x', rotation=30)
        ax3.grid(True, alpha=0.3, axis='y')
        
        # 4. 趋势线图
        ax4 = axes[1, 1]
        for idx, (book_name, data) in enumerate(all_books_results.items()):
            values = data['values']
            if len(values) > 1:
                x_normalized = np.linspace(0, 1, len(values))
                # 使用简化的标签
                label = short_names[idx]
                ax4.plot(x_normalized, values, label=label, color=colors[idx], 
                        linewidth=1.5, alpha=0.8)
        ax4.set_xlabel('归一化文本位置 (0=开始, 1=结束)')
        ax4.set_ylabel('指标值')
        ax4.set_title('趋势线比较')
        ax4.legend(loc='best', fontsize=8, ncol=2)
        ax4.grid(True, alpha=0.3)
        
        plt.tight_layout(rect=[0, 0, 1, 0.96])  # 为标题留出空间
        return fig