# Stage 1: Builder
FROM node:22-alpine AS builder

WORKDIR /usr/src/app

# Copy package files strictly for dependency installation
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies needed for build)
RUN npm ci

# Copy the rest of the application source
COPY tsconfig.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/

# Execute the production build (tsc typecheck + esbuild)
RUN npm run build

# Stage 2: Production Runtime
FROM node:22-alpine AS production

# Set NODE_ENV to production to enforce strict production behaviors in env.ts
ENV NODE_ENV=production

WORKDIR /usr/src/app

# Copy package files for production dependency installation
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Copy the compiled output and migrations from the builder stage
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/migrations ./migrations

# Expose the application port
EXPOSE 3000

# Set ownership of the working directory to the non-root 'node' user
RUN chown -R node:node /usr/src/app

# Switch to the non-root 'node' user
USER node

# Healthcheck utilizing the dependency-free liveness probe
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/v1/health/live || exit 1

# Start the application using the built artifact
CMD ["node", "dist/server.js"]
