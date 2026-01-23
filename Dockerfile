# Use Node 20
FROM node:20

# System dependencies removed - Puppeteer no longer used

# Tell Puppeteer to skip installing Chrome (we'll use installed package or let it bundle, 
# but usually in Docker we want to use the system chromium or ensure deps are present)
# Actually, node:20 is Debian based. Let's just install the deps and let Puppeteer download its chrome.


# Set working directory
WORKDIR /app

# Install dependencies for system if needed (e.g., for some mcp tools, though likely not needed for basic express/axios)
# RUN apt-get update && apt-get install -y ...

# Copy package files first to leverage cache
COPY package.json package-lock.json* ./

# Install production dependencies
RUN npm install --only=production

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Set environment variable to ensure we bind to 0.0.0.0
ENV PORT=3000

# Command to run the application
# We use shell form to allow variable expansion if needed, but simple node is fine
CMD ["node", "execution/webhook_server.js"]
