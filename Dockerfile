FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY public ./public
COPY src ./src
COPY openapi.yaml README.md .env.example ./

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATABASE_PATH=/app/data/chat-with-docs.sqlite
ENV UPLOAD_DIR=/app/data/uploads

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["npm", "start"]
