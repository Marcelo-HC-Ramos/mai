FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY mai ./mai
EXPOSE 8000
CMD ["uvicorn", "mai.api:app", "--host", "0.0.0.0", "--port", "8000"]
