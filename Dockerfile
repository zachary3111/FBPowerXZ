FROM apify/actor-node-playwright:22

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Use a directory owned by `myuser`
WORKDIR /home/myuser/app

# Copy manifests with correct ownership, then install
COPY --chown=myuser:myuser package*.json ./
# If you have package-lock.json, prefer npm ci; otherwise keep npm install
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# Copy the rest of the source (also with ownership)
COPY --chown=myuser:myuser . .

CMD ["node", "src/main.js"]
