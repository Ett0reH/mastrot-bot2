# Start with a Node 20 image (or whatever version you prefer, 18+ is good)
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy the package package.json to install dependencies first
# We copy these first to leverage Docker layer caching
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the React frontend
RUN npm run build

# Expose the port the server listens on
EXPOSE 3000

# Start the application using your dev/start script
# Since we updated the start script to run the server, this is perfect
ENV NODE_ENV=production
CMD ["npm", "start"]
