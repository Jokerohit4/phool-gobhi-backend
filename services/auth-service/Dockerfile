# deps stage: full install (incl. devDeps needed by `prisma generate`)
#
# bcrypt ships a prebuilt binary that npm downloads from GitHub releases. When
# that download fails (it 504s now and then) node-pre-gyp falls back to
# compiling from source, which needs a toolchain alpine does not have — and the
# whole build, and with it the deploy, dies. The build tools are installed only
# for the duration of `npm install` and removed in the same layer, so they never
# add to the image.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm install \
    && apk del .build-deps
COPY prisma ./prisma
RUN npx prisma generate

# runtime stage: prod-only deps, generated Prisma client copied over — keeps
# the deployed image (and Cloud Run cold-start pull) smaller than shipping
# nodemon/the prisma CLI into production.
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
# Same toolchain-for-the-install-only fallback as the deps stage above; removed
# in the same layer so the runtime image stays as small as before.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm install --omit=dev \
    && apk del .build-deps
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
COPY . .
EXPOSE 5001
CMD ["node", "app.js"]
