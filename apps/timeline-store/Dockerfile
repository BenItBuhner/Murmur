FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
ENV TIMELINE_DIR=/data/timeline
ENV PORT=8788
EXPOSE 8788
CMD ["node", "server.mjs"]
