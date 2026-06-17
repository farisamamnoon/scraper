# Stage 1: Build TypeScript application
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN apk add --no-cache python3 make g++ && npm ci
COPY src ./src
COPY public ./public
RUN npm run build

# Stage 2: Production runner
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Install only production dependencies
COPY package*.json ./
RUN apk add --no-cache python3 make g++ && \
    npm ci --only=production && \
    apk del python3 make g++

# Copy compiled code and public assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# Ensure the temp directory exists for media buffering
RUN mkdir -p temp && chmod 777 temp

EXPOSE 3000
CMD ["node", "dist/index.js"]
