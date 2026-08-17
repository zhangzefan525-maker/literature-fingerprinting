# 文学指纹 - 容器化部署
# 适用于 Zeabur / Sealos / Railway / Fly.io / Render 等所有 Docker 类平台。
FROM python:3.13-slim

WORKDIR /app

# 1) 先装依赖（单独 COPY 依赖清单，便于利用 Docker 缓存层）
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 2) 下载 NLTK 数据（punkt 分词、stopwords 停用词）
RUN python -c "import nltk; nltk.download('punkt'); nltk.download('punkt_tab'); nltk.download('stopwords')"

# 3) 复制项目源码
COPY . .

# 4) 预生成 4 本示例书的指纹数据（data/raw 已在仓库中），加速首次访问
RUN python generate_data.py

# 5) 端口：读取容器平台注入的 PORT，默认 8000
ENV PORT=8000
EXPOSE 8000

# 6) 启动（单 worker 省内存，超时放宽以容纳大文本分析）
CMD ["sh", "-c", "gunicorn api_server:app --bind 0.0.0.0:${PORT:-8000} --timeout 180 --workers 1"]
