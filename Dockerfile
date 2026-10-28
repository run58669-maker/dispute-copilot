FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
