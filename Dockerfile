# 使用官方 Node.js 运行时作为基础镜像
FROM node:18-slim

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json（如果存在）
COPY package*.json ./

# 安装依赖
RUN npm ci --only=production

# 复制应用代码
COPY server.js ./
COPY googleDrive.js ./
COPY aliyunOSS.js ./
COPY userConfig.js ./
COPY update-manager.js ./

# Cloud Run 需要监听 0.0.0.0 和端口 8080
ENV PORT=8080
ENV HOST=0.0.0.0

# 暴露端口
EXPOSE 8080

# 启动应用
CMD ["node", "server.js"]

