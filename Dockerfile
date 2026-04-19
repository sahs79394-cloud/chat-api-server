FROM node:20-alpine
WORKDIR /app
COPY package.json .
COPY server.mjs .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
