FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
# Only the files a running gateway actually needs — a blanket `COPY . .`
# would drag deploy scripts, tests, and any stray local tooling into the
# image for no runtime value (and makes the build context's surface area a
# thing an attacker could plant files into).
COPY bootstrap-secrets.js index.js ./
COPY utils ./utils
COPY docs/analytics-events.json ./docs/analytics-events.json
EXPOSE 5000
CMD ["node", "index.js"]
