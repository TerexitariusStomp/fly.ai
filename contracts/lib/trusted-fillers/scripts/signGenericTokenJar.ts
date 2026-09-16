import {
  processJarBalances,
  type SignGenericTokenJarFillRequestParams,
  type SupportedChainId,
} from "@reserve-protocol/trusted-fillers-sdk";
import { SignClient } from "@walletconnect/sign-client";
import {
  createPublicClient,
  getAddress,
  getTypesForEIP712Domain,
  http,
  isAddress,
  isAddressEqual,
  isHex,
  serializeTypedData,
} from "viem";
import type { Address, Chain, Hex, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, bsc, mainnet } from "viem/chains";

type SignerConfig =
  | {
      type: "local";
      privateKey: Hex;
    }
  | {
      type: "walletconnect";
      projectId: string;
      account: Address;
    };

type ScriptConfig = {
  chainId: SupportedChainId;
  jarAddress: Address;
  rpcUrl: string;
  signer: SignerConfig;
  tokenList: Address[];
  validityDuration: number;
};

const config: ScriptConfig = {
  chainId: base.id,
  jarAddress: "0x1f55B89D575D531446a2569158F880768686B3B8",
  rpcUrl: "https://base.gateway.tenderly.co",
  signer: {
    type: "walletconnect",
    projectId: "2447c0da755a548d21d984d7e4b6c3fa",
    account: "0x170D196640702B3CE182a3406428B68F3e7b7694",
  },
  tokenList: ["0x23418De10d422AD71C9D5713a2B8991a9c586443"],
  validityDuration: 120,
};

const chainsById = {
  [mainnet.id]: mainnet,
  [base.id]: base,
  [bsc.id]: bsc,
} satisfies Record<SupportedChainId, Chain>;

type SignedFillRequest = {
  account: Address;
  digest: Hex;
  digestMatchesRequestHash: boolean;
  request: SignGenericTokenJarFillRequestParams["request"];
  requestHash: Hex;
  signature: Hex;
};

type FillRequestSigner = {
  close: () => Promise<void>;
  sign: (params: SignGenericTokenJarFillRequestParams) => Promise<{ account: Address; signature: Hex }>;
};

function assertAddress(value: Address, name: string): Address {
  if (!isAddress(value)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return getAddress(value);
}

function assertPrivateKey(value: Hex): Hex {
  if (!isHex(value) || value.length !== 66 || value === `0x${"0".repeat(64)}`) {
    throw new Error("config.signer.privateKey must be a nonzero bytes32 hex string");
  }

  return value;
}

function getSessionAccounts(
  session: { namespaces: Record<string, { accounts?: string[] }> },
  chainId: SupportedChainId,
): Address[] {
  const prefix = `eip155:${chainId}:`;

  return Object.values(session.namespaces)
    .flatMap((namespace) => namespace.accounts ?? [])
    .filter((account) => account.toLowerCase().startsWith(prefix))
    .map((account) => assertAddress(account.slice(prefix.length) as Address, "WalletConnect account"));
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) => {
      if (typeof item === "bigint") {
        return item.toString();
      }

      return item;
    },
    2,
  );
}

function createLocalSigner(signerConfig: Extract<SignerConfig, { type: "local" }>): FillRequestSigner {
  const account = privateKeyToAccount(assertPrivateKey(signerConfig.privateKey));

  return {
    close: async () => {},
    sign: async (params) => ({
      account: account.address,
      signature: await account.signTypedData({
        domain: params.domain,
        types: params.types,
        primaryType: "FillRequest",
        message: { ...params.request },
      }),
    }),
  };
}

function createWalletConnectSigner(
  signerConfig: Extract<SignerConfig, { type: "walletconnect" }>,
  chainId: SupportedChainId,
): FillRequestSigner {
  let signClient: Awaited<ReturnType<typeof SignClient.init>> | undefined;
  let topic: string | undefined;

  return {
    close: async () => {
      if (!signClient || !topic) {
        return;
      }

      try {
        await signClient.disconnect({
          topic,
          reason: { code: 6000, message: "GenericTokenJar processing complete" },
        });
      } catch {
        // Wallets may close the session first; all requested signatures were already captured.
      }
    },
    sign: async (params) => {
      if (!signClient || !topic) {
        signClient = await SignClient.init({
          projectId: signerConfig.projectId,
          metadata: {
            name: "Reserve Trusted Fillers",
            description: "Signs GenericTokenJar fill requests",
            url: "https://app.reserve.org",
            icons: [],
          },
        });

        const { uri, approval } = await signClient.connect({
          requiredNamespaces: {
            eip155: {
              methods: ["eth_signTypedData_v4"],
              chains: [`eip155:${chainId}`],
              events: ["accountsChanged", "chainChanged"],
            },
          },
        });

        if (uri) {
          console.log("WalletConnect URI:");
          console.log(uri);
          console.log(
            "Approve the session in your wallet. Signature requests will appear as jar balances are processed.",
          );
        }

        const session = await approval();
        const accounts = getSessionAccounts(session, chainId);
        topic = session.topic;

        if (!accounts.some((approvedAccount) => isAddressEqual(approvedAccount, signerConfig.account))) {
          throw new Error(`Expected account ${signerConfig.account} was not approved by the WalletConnect session`);
        }
      }

      const typedData = {
        domain: {
          ...params.domain,
          chainId: BigInt(params.domain.chainId),
        },
        types: {
          EIP712Domain: getTypesForEIP712Domain({ domain: params.domain }),
          ...params.types,
        },
        primaryType: "FillRequest",
        message: { ...params.request },
      } as const;
      const signature = (await signClient.request({
        topic,
        chainId: `eip155:${chainId}`,
        request: {
          method: "eth_signTypedData_v4",
          params: [signerConfig.account, serializeTypedData(typedData as Parameters<typeof serializeTypedData>[0])],
        },
      })) as Hex;

      if (!isHex(signature)) {
        throw new Error("WalletConnect returned a non-hex signature");
      }

      return { account: signerConfig.account, signature };
    },
  };
}

function createSigner(signerConfig: SignerConfig, chainId: SupportedChainId): FillRequestSigner {
  return signerConfig.type === "walletconnect"
    ? createWalletConnectSigner(signerConfig, chainId)
    : createLocalSigner(signerConfig);
}

async function main(): Promise<void> {
  const jarAddress = assertAddress(config.jarAddress, "config.jarAddress");
  const tokenList = config.tokenList.map((token) => assertAddress(token, "config.tokenList"));
  const client = createPublicClient({
    chain: chainsById[config.chainId],
    transport: http(config.rpcUrl),
  }) as unknown as PublicClient;
  const signer = createSigner(config.signer, config.chainId);
  const signedFillRequests: SignedFillRequest[] = [];

  try {
    const processResult = await processJarBalances({
      chainId: config.chainId,
      client,
      jarAddress,
      tokenList,
      validityDuration: config.validityDuration,
      signFillRequest: async (params) => {
        const { account, signature } = await signer.sign(params);

        signedFillRequests.push({
          account,
          digest: params.digest,
          digestMatchesRequestHash: params.digest.toLowerCase() === params.requestHash.toLowerCase(),
          request: params.request,
          requestHash: params.requestHash,
          signature,
        });

        return signature;
      },
    });

    console.log(
      stringify({
        jarAddress,
        tokenList,
        processResult,
        signedFillRequests,
      }),
    );
  } finally {
    await signer.close();
  }
}

await main();
