FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends docker.io ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY app.py /app/app.py
EXPOSE 8080
USER 65532:65532
CMD ["python", "/app/app.py"]
