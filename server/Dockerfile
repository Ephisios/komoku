# Le serveur n'a aucune dépendance npm : il n'utilise que les modules intégrés
# à Node, dont node:sqlite. Rien à installer, rien à compiler.
FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

# La base vit dans un volume, pas dans l'image.
RUN mkdir -p /data && chown -R node:node /data /app
ENV DB_PATH=/data/komoku.db
ENV HOST=0.0.0.0
ENV PORT=8080
VOLUME ["/data"]

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
