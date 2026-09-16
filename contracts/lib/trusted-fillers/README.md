# Reserve Trusted Fillers

Trusted Fillers are used by protocols within the Reserve ecosystem to support async swaps with known fillers. Trusted Fillers use async settlements for the requested tokens and amounts such that the protocol mimics any other trading entity acting through approvals and intents. They are "async" to convey they happen out-of-bound and do not directly call into the contracts unlike the Dutch Auction atomic swap bids implemented within the protocols.

Since swaps happen async and without the contract knowing every single detail, we refer to them as "trusted" fillers. The contracts in this repo are designed to limit what they can do and enforce protocol restrictions and limitations on them when they perform the swap via EIP-1271. However, adherence to EIP-1271 by the filler cannot be enforced.

The core entrypoint for the protocols is the `TrustedFillerRegistry` which holds a list of available fillers that can be used by any of the implementing protocols to fulfil trading intents while tapping into the larger DeFi ecosystem.

## Supported Protocols

The following Trusted Fillers are currently implemented and supported by the Trusted Fillers integration. See code for each individual filler for specific implementation details.

### CoW Swap

CoW Swap is the largest intent based trading protocol with an extremely large solver set, along with (some) guarantees that the fulfilments are best available at the time of execution.

The integration is enforced using the `CowSwapFiller.sol` contract which is responsible for enforcing protocol restrictions and pricing to the individual trades.

## Utilizing Protocols

The following protocols in the Reserve ecosystem utilize the Trusted Fillers. Each of the protocols also have their own tests to enforce the behaviour of each available filler.

### Reserve Folio

Starting with release 3.0.0 of the Reserve Folio protocol, each deployed Folio can opt into enabling Trusted Fillers which allow each of the rebalancing trades to utilize supported fillers to bid on the auctions.
