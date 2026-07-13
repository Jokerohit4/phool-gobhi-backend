# deps stage: full install (incl. devDeps needed by `prisma generate`)
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY prisma ./prisma
RUN npx prisma generate

# runtime stage: prod-only deps, generated Prisma client copied over — keeps
# the deployed image (and Cloud Run cold-start pull) smaller than shipping
# nodemon/the prisma CLI into production.
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
COPY . .
EXPOSE 5004
CMD ["node", "app.js"]
