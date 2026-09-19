FROM node:lts
WORKDIR /app

# 1) 先装依赖（npm workspaces：根 + frontend 两份清单都要在，npm install 才会同时装前端依赖）
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
RUN npm install

# 2) 源码 + 容器内构建前端（生成 public/index.html 与 public/assets，
#    避免仓库里提交的 index.html 与 assets 版本对不上导致白屏）
COPY frontend ./frontend
COPY public ./public
COPY src ./src
COPY wrangler.jsonc entrypoint.sh schema.set.sql ./
RUN npm run build

RUN npm install -g wrangler
RUN chmod +x ./entrypoint.sh
RUN apt update && apt install -y cron
COPY src/http.js ./node_modules/acme-client/src/
RUN wrangler d1 execute DB_CF --local --file schema.set.sql
RUN echo "*/1 * * * * root curl 127.0.0.1:3000/tasks/" >> /etc/crontab
EXPOSE 3000
ENTRYPOINT ["sh","/app/entrypoint.sh"]
