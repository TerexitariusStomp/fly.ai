import { defineConfig } from "orval";
import { config } from "dotenv";

config();

const API_URL =
  process.env.SYM_API_URL ?? "https://dev-symbient-protocol-api.callisto.finance/openapi.json";

export default defineConfig({
  symbientUnits: {
    input: {
      target: API_URL,
    },
    output: {
      target: "generated-symbientUnits.ts",
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
