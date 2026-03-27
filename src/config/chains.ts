/**
 * Chain configurations for all 8 supported networks.
 *
 * EVM chains use ethers.js JsonRpcProvider.
 * Solana uses @solana/web3.js Connection.
 * Stellar uses the Horizon REST API via @stellar/stellar-sdk.
 *
 * RPC URLs can be overridden via environment variables for private endpoints
 * with higher rate limits (recommended for production).
 */

export type Chain =
  | 'ethereum'
  | 'bnb'
  | 'base'
  | 'arbitrum'
  | 'polygon'
  | 'avalanche'
  | 'solana'
  | 'stellar';

export type ChainType = 'evm' | 'solana' | 'stellar';

export interface EvmChainConfig {
  type: 'evm';
  name: string;
  chain: Chain;
  chainId: number;
  rpcUrl: string;
  blockExplorer: string;
  nativeCurrency: string;
  /** Chainlink LINK/USD feed — used to validate feed connectivity */
  testFeedAddress: string;
}

export interface SolanaChainConfig {
  type: 'solana';
  name: string;
  chain: Chain;
  rpcUrl: string;
}

export interface StellarChainConfig {
  type: 'stellar';
  name: string;
  chain: Chain;
  horizonUrl: string;
  networkPassphrase: string;
}

export type ChainConfig = EvmChainConfig | SolanaChainConfig | StellarChainConfig;

const CHAINS: Record<Chain, ChainConfig> = {
  ethereum: {
    type: 'evm',
    name: 'Ethereum',
    chain: 'ethereum',
    chainId: 1,
    rpcUrl:
      process.env['ETHEREUM_RPC_URL'] ??
      'https://eth-mainnet.g.alchemy.com/v2/demo',
    blockExplorer: 'https://etherscan.io',
    nativeCurrency: 'ETH',
    // Chainlink ETH/USD on Ethereum mainnet
    testFeedAddress: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
  },

  bnb: {
    type: 'evm',
    name: 'BNB Chain',
    chain: 'bnb',
    chainId: 56,
    rpcUrl: process.env['BNB_RPC_URL'] ?? 'https://bsc-dataseed.binance.org',
    blockExplorer: 'https://bscscan.com',
    nativeCurrency: 'BNB',
    // Chainlink BNB/USD on BNB Chain
    testFeedAddress: '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE',
  },

  base: {
    type: 'evm',
    name: 'Base',
    chain: 'base',
    chainId: 8453,
    rpcUrl: process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org',
    blockExplorer: 'https://basescan.org',
    nativeCurrency: 'ETH',
    // Chainlink ETH/USD on Base
    testFeedAddress: '0x71041dddad3595F9CEd3dCCFBe3D1F4b0a16Bb70',
  },

  arbitrum: {
    type: 'evm',
    name: 'Arbitrum One',
    chain: 'arbitrum',
    chainId: 42161,
    rpcUrl: process.env['ARBITRUM_RPC_URL'] ?? 'https://arb1.arbitrum.io/rpc',
    blockExplorer: 'https://arbiscan.io',
    nativeCurrency: 'ETH',
    // Chainlink ETH/USD on Arbitrum
    testFeedAddress: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
  },

  polygon: {
    type: 'evm',
    name: 'Polygon',
    chain: 'polygon',
    chainId: 137,
    rpcUrl: process.env['POLYGON_RPC_URL'] ?? 'https://polygon-rpc.com',
    blockExplorer: 'https://polygonscan.com',
    nativeCurrency: 'MATIC',
    // Chainlink MATIC/USD on Polygon
    testFeedAddress: '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0',
  },

  avalanche: {
    type: 'evm',
    name: 'Avalanche C-Chain',
    chain: 'avalanche',
    chainId: 43114,
    rpcUrl:
      process.env['AVALANCHE_RPC_URL'] ??
      'https://api.avax.network/ext/bc/C/rpc',
    blockExplorer: 'https://snowtrace.io',
    nativeCurrency: 'AVAX',
    // Chainlink AVAX/USD on Avalanche
    testFeedAddress: '0x0A77230d17318075983913bC2145DB16C7366156',
  },

  solana: {
    type: 'solana',
    name: 'Solana',
    chain: 'solana',
    rpcUrl:
      process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com',
  },

  stellar: {
    type: 'stellar',
    name: 'Stellar',
    chain: 'stellar',
    horizonUrl: process.env['STELLAR_HORIZON_URL'] ?? 'https://horizon.stellar.org',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
  },
};

export default CHAINS;

/** Helper: get all EVM chains */
export function getEvmChains(): EvmChainConfig[] {
  return Object.values(CHAINS).filter(
    (c): c is EvmChainConfig => c.type === 'evm'
  );
}

/** Helper: get config for a specific chain */
export function getChainConfig(chain: Chain): ChainConfig {
  return CHAINS[chain];
}
