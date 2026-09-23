# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps first (layer cache)
COPY package*.json ./
RUN npm install

# Copy Prisma schema and generate client
COPY prisma ./prisma/
RUN npx prisma generate

# Copy source and build
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

# ─── Stage 2: Production ──────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Only production deps
COPY package*.json ./
RUN npm install --omit=dev

# Copy built output and Prisma client
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY prisma ./prisma/

EXPOSE 3000

# Run migrations then start
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
