# Build from the PROJECT ROOT (~/Documents/blocksee-demo), not this directory:
#   docker build -f consenti-server/Dockerfile -t blocksee-sales-agent .
# server.js reads demo.html via path.join(__dirname, '..', 'demo.html'), so
# demo.html must land at the image root (/demo.html), one level above /app.

FROM node:22-alpine

WORKDIR /app

COPY consenti-server/package.json consenti-server/package-lock.json ./
RUN npm ci --production

COPY consenti-server/server.js consenti-server/pdf.js ./
COPY demo.html /demo.html

EXPOSE 3000

CMD ["node", "server.js"]
