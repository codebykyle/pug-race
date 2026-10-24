# Provably Fair Pug Race — watch-party server.
# No dependencies and no build step: the image is just Node plus the app files.
FROM node:22-alpine

WORKDIR /app
COPY index.html server.js verify.js README.md ./

# Key, host password and saved event state live here; mount a volume to keep
# them across container restarts.
ENV PUG_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 8731

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8731/api/time >/dev/null || exit 1

ENTRYPOINT ["node", "server.js"]
CMD ["8731"]
