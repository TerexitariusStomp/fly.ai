//! EVM client layer — ic-alloy (vendored alloy fork with ICP transport +
//! threshold-ECDSA signer). All contract ABIs declared with alloy's `sol!`
//! macro — replaces wp-evm-aave-v3 / uniswap-v3-sdk / wp-evm-v3-core, which
//! pin an incompatible upstream alloy version.
//!
//! Signing model: IcpSigner derives an EVM address from the canister's
//! threshold ECDSA key at a per-connectome derivation path. No private key
//! material ever exists.

use alloy::network::EthereumWallet;
use alloy::primitives::{Address, Bytes, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::{Filter, TransactionRequest};
use alloy::signers::icp::IcpSigner;
use alloy::signers::Signer as _;
use alloy::sol;
use alloy::sol_types::{SolCall, SolEvent};
use alloy::transports::icp::{IcpConfig, IcpTransport, RpcApi, RpcService};
use std::str::FromStr;

use crate::replication;

// ============================================================================
// sol! bindings — OSS ABI codegen, no hand-rolled encoding
// ============================================================================

sol! {
    #[sol(rpc)]
    interface IERC20 {
        function balanceOf(address owner) external view returns (uint256);
        function transfer(address to, uint256 amount) external returns (bool);
        function approve(address spender, uint256 amount) external returns (bool);
        function decimals() external view returns (uint8);
    }
}

sol! {
    #[sol(rpc)]
    interface IConnectomeGovernor {
        function execute(bytes32 proposalId) external returns (bytes);
    }
}

sol! {
    #[sol(rpc)]
    interface ISocialPostLog {
        event SocialPost(
            bytes32 indexed connectomeId,
            uint8 postType,
            string content,
            uint256 timestamp,
            uint256 blockNumber
        );
    }
}

sol! {
    #[sol(rpc)]
    interface IAaveV3Pool {
        function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    }
}

sol! {
    #[sol(rpc)]
    interface IWETH {
        function deposit() external payable;
        function withdraw(uint256 amount) external;
    }
}

sol! {
    #[sol(rpc)]
    interface ISwapRouter {
        struct ExactInputSingleParams {
            address tokenIn;
            address tokenOut;
            uint24 fee;
            address recipient;
            uint256 deadline;
            uint256 amountIn;
            uint256 amountOutMinimum;
            uint160 sqrtPriceLimitX96;
        }
        function exactInputSingle(ExactInputSingleParams params) external payable returns (uint256);
    }
}

sol! {
    #[sol(rpc)]
    interface INonfungiblePositionManager {
        struct MintParams {
            address token0;
            address token1;
            uint24 fee;
            int24 tickLower;
            int24 tickUpper;
            uint256 amount0Desired;
            uint256 amount1Desired;
            uint256 amount0Min;
            uint256 amount1Min;
            address recipient;
            uint256 deadline;
        }
        function mint(MintParams params) external payable returns (uint256, uint128, uint256, uint256);
        struct CollectParams {
            uint256 tokenId;
            address recipient;
            uint128 amount0Max;
            uint128 amount1Max;
        }
        function collect(CollectParams params) external payable returns (uint256, uint256);
        function positions(uint256 tokenId) external view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128);
    }
}

sol! {
    #[sol(rpc)]
    interface IUniswapV3Pool {
        function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    }
}

// ============================================================================
// Provider / signer helpers
// ============================================================================

/// Read-only provider through the EVM RPC canister (IcpTransport → Custom RPC
/// service for Arc). Signing path attaches the wallet filler + IcpSigner.
pub fn evm_provider(rpc_url: &str) -> impl Provider<IcpTransport> + Clone {
    let config = IcpConfig::new(RpcService::Custom(RpcApi {
        url: rpc_url.to_string(),
        headers: None,
    }));
    ProviderBuilder::new().on_icp(config)
}

/// Signing provider for one connectome — threshold ECDSA at its derivation path.
pub async fn signing_provider(
    rpc_url: &str,
    cid: &str,
    key_name: &str,
    chain_id: u64,
) -> Result<impl Provider<IcpTransport> + Clone, String> {
    let signer = IcpSigner::new(replication::derivation_path_for(cid), key_name, Some(chain_id))
        .await
        .map_err(|e| format!("IcpSigner: {}", e))?;
    let wallet = EthereumWallet::from(signer);
    let config = IcpConfig::new(RpcService::Custom(RpcApi {
        url: rpc_url.to_string(),
        headers: None,
    }));
    Ok(ProviderBuilder::new()
        .with_recommended_fillers()
        .wallet(wallet)
        .on_icp(config))
}

/// A connectome's EVM address = threshold-ECDSA pubkey at its derivation path.
pub async fn evm_address(cid: &str, key_name: &str) -> Result<Address, String> {
    let signer = IcpSigner::new(replication::derivation_path_for(cid), key_name, None)
        .await
        .map_err(|e| format!("IcpSigner: {}", e))?;
    Ok(signer.address())
}

// ============================================================================
// Reads
// ============================================================================

pub async fn erc20_balance(
    provider: &impl Provider<IcpTransport>,
    token: Address,
    owner: Address,
) -> Result<U256, String> {
    IERC20::new(token, provider)
        .balanceOf(owner)
        .call()
        .await
        .map(|r| r._0)
        .map_err(|e| format!("balanceOf: {}", e))
}

pub async fn latest_block(provider: &impl Provider<IcpTransport>) -> Result<u64, String> {
    provider
        .get_block_number()
        .await
        .map_err(|e| format!("get_block_number: {}", e))
}

/// eth_chainId — constant per chain, so HTTPS outcalls reach consensus.
/// Use for connectivity healthchecks (block numbers never do).
pub async fn chain_id(provider: &impl Provider<IcpTransport>) -> Result<u64, String> {
    provider
        .get_chain_id()
        .await
        .map_err(|e| format!("chain_id: {}", e))
}

/// Poll SocialPostLog events in (from_block, latest].
pub async fn fetch_social_posts(
    provider: &impl Provider<IcpTransport>,
    log_addr: Address,
    from_block: u64,
) -> Result<Vec<(u64, u32, ISocialPostLog::SocialPost)>, String> {
    let filter = Filter::new()
        .address(log_addr)
        .event_signature(ISocialPostLog::SocialPost::SIGNATURE_HASH)
        .from_block(from_block);
    let logs = provider
        .get_logs(&filter)
        .await
        .map_err(|e| format!("get_logs: {}", e))?;
    let mut out = Vec::new();
    for log in logs {
        if let Ok(ev) = log.log_decode::<ISocialPostLog::SocialPost>() {
            let data = ev.inner.data;
            out.push((
                log.block_number.unwrap_or(0),
                log.log_index.unwrap_or(0) as u32,
                data,
            ));
        }
    }
    Ok(out)
}

// ============================================================================
// Writes — all go through validate → capability → sign → submit upstream
// ============================================================================

/// Submit a raw call to a whitelisted contract via the connectome's signer.
pub async fn send_call(
    provider: &impl Provider<IcpTransport>,
    to: Address,
    calldata: Vec<u8>,
    value: U256,
) -> Result<String, String> {
    let tx = TransactionRequest::default()
        .to(to)
        .input(alloy::rpc::types::TransactionInput::new(Bytes::from(calldata)))
        .value(value);
    let pending = provider
        .send_transaction(tx)
        .await
        .map_err(|e| format!("send_transaction: {}", e))?;
    Ok(format!("{:?}", pending.tx_hash()))
}

/// Governor.execute(proposalId) — connectome executing a passed proposal.
pub fn governor_execute_calldata(proposal_id: [u8; 32]) -> Vec<u8> {
    IConnectomeGovernor::executeCall {
        proposalId: proposal_id.into(),
    }
    .abi_encode()
}

pub fn aave_supply_calldata(asset: Address, amount: U256, on_behalf_of: Address) -> Vec<u8> {
    IAaveV3Pool::supplyCall {
        asset,
        amount,
        onBehalfOf: on_behalf_of,
        referralCode: 0,
    }
    .abi_encode()
}

pub fn erc20_approve_calldata(spender: Address, amount: U256) -> Vec<u8> {
    IERC20::approveCall { spender, amount }.abi_encode()
}

pub fn weth_deposit_calldata() -> Vec<u8> {
    IWETH::depositCall {}.abi_encode()
}

pub fn swap_exact_input_single(
    token_in: Address,
    token_out: Address,
    fee: u32,
    recipient: Address,
    amount_in: U256,
    amount_out_min: U256,
    deadline: u64,
) -> Vec<u8> {
    ISwapRouter::exactInputSingleCall {
        params: ISwapRouter::ExactInputSingleParams {
            tokenIn: token_in,
            tokenOut: token_out,
            fee: fee.try_into().unwrap_or_default(),
            recipient,
            deadline: U256::from(deadline),
            amountIn: amount_in,
            amountOutMinimum: amount_out_min,
            sqrtPriceLimitX96: alloy::primitives::U160::ZERO,
        },
    }
    .abi_encode()
}

pub fn erc20_transfer_calldata(to: Address, amount: U256) -> Vec<u8> {
    IERC20::transferCall { to, amount }.abi_encode()
}

/// ERC20Burnable.burn — for internal FLYAI token; Tolly fixed-supply tokens
/// lack it, so callers must dead-sink via transfer instead (checked upstream).
pub fn erc20_burn_calldata(amount: U256) -> Vec<u8> {
    // burn(uint256) selector = 0x42966c68
    let mut data = vec![0x42, 0x96, 0x6c, 0x68];
    data.extend_from_slice(&amount.to_be_bytes::<32>());
    data
}

/// Mint a UniV3 LP position via the NonfungiblePositionManager.
#[allow(clippy::too_many_arguments)]
pub fn univ3_mint_calldata(
    token0: Address,
    token1: Address,
    fee: u32,
    tick_lower: i32,
    tick_upper: i32,
    amount0: U256,
    amount1: U256,
    recipient: Address,
    deadline: u64,
) -> Vec<u8> {
    INonfungiblePositionManager::mintCall {
        params: INonfungiblePositionManager::MintParams {
            token0,
            token1,
            fee: fee.try_into().unwrap_or_default(),
            tickLower: tick_lower.try_into().unwrap_or_default(),
            tickUpper: tick_upper.try_into().unwrap_or_default(),
            amount0Desired: amount0,
            amount1Desired: amount1,
            amount0Min: U256::ZERO,
            amount1Min: U256::ZERO,
            recipient,
            deadline: U256::from(deadline),
        },
    }
    .abi_encode()
}

/// Pool tick from slot0 (for in-range checks / LP tick selection).
pub async fn pool_tick(provider: &impl Provider<IcpTransport>, pool: Address) -> Result<i32, String> {
    IUniswapV3Pool::new(pool, provider)
        .slot0()
        .call()
        .await
        .map(|r| r._1.try_into().unwrap_or(0))
        .map_err(|e| format!("slot0: {}", e))
}

pub fn parse_addr(s: &str) -> Result<Address, String> {
    Address::from_str(s).map_err(|e| format!("bad address {}: {}", s, e))
}
