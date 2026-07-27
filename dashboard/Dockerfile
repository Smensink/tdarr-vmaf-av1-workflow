FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json /app/package.json

# better-sqlite3 builds a native addon; install build deps only for the install step.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && npm install --omit=dev \
  && apk del .build-deps

COPY server.js /app/server.js
COPY public /app/public

EXPOSE 8686
CMD ["node", "server.js"]
