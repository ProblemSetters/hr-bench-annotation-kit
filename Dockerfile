FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 KIT_DIR=/kit KIT_HOST=0.0.0.0
WORKDIR /kit
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY label_schema.json .
COPY kitapp ./kitapp
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8790/healthz')"
CMD ["python", "-m", "kitapp"]
