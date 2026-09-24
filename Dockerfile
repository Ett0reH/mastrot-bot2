# Immagine del bot: un solo processo (server + runtime). Deploy su Cloud Run con min=max=1
# istanze e CPU sempre allocata (deploy/cloudrun-service.yaml) oppure su una VPS con Docker.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# node direttamente (non npm): il SIGTERM dei deploy arriva al server, che ferma i cicli,
# salva lo stato e rilascia il lease, così la nuova revisione subentra subito.
CMD ["node", "dist/server.cjs"]
