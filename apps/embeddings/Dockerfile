FROM python:3.12-slim

WORKDIR /app

# Install torch CPU-only first (avoids pulling ~2GB of CUDA libs)
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

# Install sentence-transformers
RUN pip install --no-cache-dir sentence-transformers

# Pre-download the model at build time so startup is fast
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

COPY main.py .

EXPOSE 8080

CMD ["python", "main.py"]
