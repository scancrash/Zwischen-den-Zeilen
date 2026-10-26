FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
ENV PORT=3000 DB_PATH=/data/buchclub.db NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 3000
CMD ["node", "server/index.js"]
