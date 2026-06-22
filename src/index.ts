import express from "express";
import dotenv from "dotenv";
import shortenRouter from "./routes/shorten";
import redirectRouter from "./routes/redirect";
import { connectRedis } from "./db/redisClient";
import { startClickFlushJob } from "./jobs/scheduler";

dotenv.config();

const app = express();
app.use(express.json());
app.use(shortenRouter);
app.use(redirectRouter);

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await connectRedis();
  } catch (err) {
    console.error("Failed to connect to Redis. Continuing without cache.", err);
  }

  startClickFlushJob();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
