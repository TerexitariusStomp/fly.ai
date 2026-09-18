import { defineConfig } from "orval";
import { config } from "dotenv";

config();

const API_URL =
  process.env.FLYAI_API_URL ?? "https://api-worker.terexmaps.workers.dev/openapi.json";

export default defineConfig({
  flyaiUnits: {
    input: {
      target: API_URL,
    },
    output: {
      target: "generated-flyaiUnits.ts",
      client: "react-query",
      clean: true,
      override: {
        mutator: {
          path: "api-customHttpClient.ts",
          name: "customHttpClient",
        },
        useTypeOverInterfaces: true,
        query: {
          useQuery: true,
          useMutation: true,
          useInfinite: false,
        },
        fetch: {
          includeHttpResponseReturnType: false,
        },
      },
    },
    // hooks: {
    //   afterAllFilesWrite: "biome check --write",
    // },
  },
});
