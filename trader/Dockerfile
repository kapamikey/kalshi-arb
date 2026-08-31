FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock* ./
COPY trader ./trader
COPY supabase/functions/scan ./supabase/functions/scan
RUN bun install --production
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "run", "trader/index.ts"]
