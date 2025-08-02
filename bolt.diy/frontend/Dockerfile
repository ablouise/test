# Stage 1: Build
FROM node:20.18.0-alpine AS builder

WORKDIR /app

# 1. Copy package files first for layer caching
COPY ./frontend/package.json ./

RUN npm install

# 3. Copy all files
COPY . .



# Stage 2: Runtime
FROM nginx:1.25-alpine

# 1. Copy built assets from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# 2. Copy custom nginx config
COPY ./frontend/nginx.conf /etc/nginx/conf.d/default.conf

# 3. Environment variables for runtime
ENV NGINX_PORT=5173 \
    NGINX_HOST=0.0.0.0

# 4. Expose port
EXPOSE 5173

# 5. Health check
HEALTHCHECK --interval=30s --timeout=3s \
  CMD curl -f http://localhost:5173 || exit 1