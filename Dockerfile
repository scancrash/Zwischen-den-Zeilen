FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
# Ohne DATABASE_URL läuft eingebettetes Postgres (PGlite) im Volume /data; mit DATABASE_URL wird ein externes Postgres genutzt.
ENV PORT=3000 DB_PATH=/data/pglite TRUST_PROXY=1 NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
