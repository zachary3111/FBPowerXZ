FROM apify/actor-node-playwright:22

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Ensure the work dir exists and is writable by myuser
USER root
RUN mkdir -p /home/myuser/app && chown -R myuser:myuser /home/myuser/app
WORKDIR /home/myuser/app

# Copy manifests with the right ownership
COPY --chown=myuser:myuser package*.json ./

# Install deps as myuser (no root needed once perms are correct)
USER myuser
# Use npm ci only if a lockfile exists; otherwise fallback to npm install
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund ; \
    else \
      npm install --omit=dev --no-audit --no-fund ; \
    fi

# Copy the rest of the source, keeping ownership
USER root
COPY --chown=myuser:myuser . .
USER myuser

CMD ["node", "src/main.js"]
