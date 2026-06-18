FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js db.js ./
RUN mkdir -p data
ENV NODE_ENV=production
EXPOSE 8000
CMD ["node", "server.js"]
