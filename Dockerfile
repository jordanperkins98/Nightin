# NightIn — small Node image for Synology / Portainer
FROM node:20-alpine

WORKDIR /app

# install deps first for layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# app source
COPY server.js index.html ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
