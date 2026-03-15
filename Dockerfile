FROM node:18-slim

RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY ffmpeg-server.js ./

EXPOSE 3000

CMD ["node", "ffmpeg-server.js"]
