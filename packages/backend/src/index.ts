import { createServer } from "./server";

const port = Number(process.env.PORT ?? 4000);

createServer().listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: "info", msg: "backend listening", port }));
});
