import { http, createPublicClient, parseUnits, Hex, keccak256 } from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  SupportedChainId,
  OrderKind,
  UnsignedOrder,
  SellTokenSource,
  BuyTokenDestination,
  OrderSigningUtils,
  setGlobalAdapter,
  SigningScheme,
  OrderBalance,
} from "@cowprotocol/cow-sdk";
import { ViemAdapter } from "@cowprotocol/sdk-viem-adapter";

// Known Key: 0x04824AE7B6681c38108A668EEB983b691f62bc6b
const account = privateKeyToAccount("0xb93542f3d387519a84549b74c3f1948cff1b08ec464ee031e4068901648fa726");
const adapter = new ViemAdapter({
  provider: createPublicClient({
    chain: mainnet,
    transport: http(),
  }),
  signer: account,
});

setGlobalAdapter(adapter);

const orderToSign: UnsignedOrder = {
  sellToken: "0x2e234DAe75C793f67A35089C9d99245E1C58470b",
  buyToken: "0xF62849F9A0B5Bf2913b396098F7c7019b51A820a",
  receiver: "0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9",
  sellAmount: parseUnits("1", 18).toString(),
  buyAmount: parseUnits("2", 18).toString(),
  validTo: 1730000000,
  appData: "0x0000000000000000000000000000000000000000000000000000000000000000",
  feeAmount: "0",
  kind: OrderKind.SELL,
  partiallyFillable: false,
  sellTokenBalance: SellTokenSource.ERC20,
  buyTokenBalance: BuyTokenDestination.ERC20,
  signingScheme: SigningScheme.EIP712,
};

const data = await OrderSigningUtils.generateOrderId(
  SupportedChainId.MAINNET,
  {
    ...orderToSign,
    sellTokenBalance: OrderBalance.ERC20,
    buyTokenBalance: OrderBalance.ERC20,
  },
  {
    owner: orderToSign.receiver,
  },
);

const signedMessage = await account.signMessage({
  message: {
    raw: keccak256(data.orderDigest as Hex),
  },
});

console.log({ data, signedMessage });
