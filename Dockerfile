FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DATA_DIR=/data PORT=8000
WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
RUN useradd --system --uid 10001 cool && mkdir -p /data && chown cool /data
USER cool
VOLUME /data
EXPOSE 8000

# Un seul processus : la base SQLite et le limiteur de débit sont locaux à l'instance.
# --proxy-headers : l'hébergeur termine le HTTPS et transmet l'adresse réelle du visiteur.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
