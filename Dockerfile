FROM node:20-alpine

WORKDIR /app

# Abhängigkeiten zuerst (bessere Layer-Caches)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Anwendungscode
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Fragen & Konfiguration liegen unter /app/data bzw. /app/config
# und können als Volume überschrieben werden.
CMD ["node", "src/server.js"]
