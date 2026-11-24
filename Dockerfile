# Nerikone web version: one document per visitor, with upload and size limits (server.py --public).
#   docker build -t nerikone .
#   docker run -p 8080:8080 nerikone                         -> http://localhost:8080/
#   docker run -p 8080:8080 -e NERIKONE_BASE=/nerikone nerikone   (serve under a sub-path)
FROM python:3.13-slim

RUN pip install --no-cache-dir smlibpy==0.6.2 \
 && useradd --system --no-create-home nerikone
WORKDIR /app
COPY nerikone/ nerikone/

ENV NERIKONE_PUBLIC=1 NERIKONE_HOST=0.0.0.0 NERIKONE_PORT=8080 PYTHONUNBUFFERED=1
USER nerikone
EXPOSE 8080
CMD ["python", "nerikone/server.py"]
