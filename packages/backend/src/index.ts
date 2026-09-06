import { EnvValidationError, loadEnv } from "./config/env";
import { createServer } from "./server";

function main(): void {
  let env;

  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // Fail fast and loudly: a half-configured server is worse than no server.
      // eslint-disable-next-line no-console
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  createServer().listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ level: "info", msg: "backend listening", port: env.PORT }));
  });
}

main();
