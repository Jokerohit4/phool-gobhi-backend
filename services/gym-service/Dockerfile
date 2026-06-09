FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
EXPOSE 5004
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node app.js"]
