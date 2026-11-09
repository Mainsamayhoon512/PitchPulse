# One image for both the API and the live service. Choose what runs with the command:
#   docker run ... pitchpulse npm run api
#   docker run ... pitchpulse npm run live
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Prisma needs OpenSSL on Alpine.
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
# tsx is a dev dependency but it is what runs the code, so install everything.
RUN npm ci --include=dev

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src

EXPOSE 3000
USER node
CMD ["npm", "run", "api"]
