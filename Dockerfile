FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY mai ./mai
EXPOSE 8000
# PORT é definido pela hospedagem (Render, Railway); localmente fica 8000
CMD ["sh", "-c", "exec uvicorn mai.api:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
