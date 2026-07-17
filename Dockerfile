FROM node:20-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

# Dependências necessárias para o better-sqlite3 compilar dentro da imagem.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

EXPOSE 3030

CMD ["npm", "start"]
