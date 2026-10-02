# The Supervisor builds this on the Home Assistant host (docker buildx) and adds the io.hass.* labels itself. It no
# longer passes a base image (BUILD_FROM, build.yaml), so the FROM is explicit. It stays on Alpine 3.23: each build
# takes that line's latest base image and Alpine's nodejs package of the day.
FROM ghcr.io/home-assistant/base:3.23
RUN apk add --no-cache nodejs
WORKDIR /app
COPY lib/ ./lib/
COPY watch.mjs watch-lib.mjs ./
CMD ["node", "/app/watch.mjs"]
