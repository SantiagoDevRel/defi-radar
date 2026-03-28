/**
 * Protocol registry — metadata for every protocol DeFi Radar supports.
 *
 * This drives the risk calculator (audit status, protocol age) and the
 * UI protocol filter. Adapters self-register by referencing their protocol ID.
 */

import type { Chain } from './chains';

export type AuditStatus = 'top-firm' | 'known-firm' | 'no-audit';

export interface ProtocolMeta {
  /** Unique slug, must match adapter's `name` field */
  id: string;
  displayName: string;
  chains: Chain[];
  /** Date the protocol was first deployed on mainnet */
  launchDate: string; // ISO 8601
  auditStatus: AuditStatus;
  /** Audit firm names, empty if no audit */
  auditFirms: string[];
  /** URL to audit report */
  auditUrl?: string;
  /** Protocol's own website */
  website: string;
  /** DeFiLlama slug for reference (not used for data fetching) */
  defillamaSlug?: string;
  /** Protocol description shown in UI */
  description: string;
}

const PROTOCOLS: Record<string, ProtocolMeta> = {
  venus: {
    id: 'venus',
    displayName: 'Venus Protocol',
    chains: ['bnb'],
    launchDate: '2020-09-28',
    auditStatus: 'known-firm',
    auditFirms: ['CertiK', 'SlowMist'],
    auditUrl: 'https://github.com/VenusProtocol/venus-protocol/tree/main/audits',
    website: 'https://venus.io',
    defillamaSlug: 'venus',
    description:
      'Algorithmic money market and synthetic stablecoin protocol on BNB Chain.',
  },

  aave: {
    id: 'aave',
    displayName: 'Aave',
    chains: ['ethereum', 'polygon', 'arbitrum', 'avalanche', 'base'],
    launchDate: '2020-01-08',
    auditStatus: 'top-firm',
    auditFirms: ['Trail of Bits', 'OpenZeppelin', 'Sigma Prime'],
    auditUrl: 'https://github.com/aave/aave-v3-core/tree/master/audits',
    website: 'https://aave.com',
    defillamaSlug: 'aave-v3',
    description:
      'Leading decentralized liquidity protocol for lending and borrowing.',
  },

  compound: {
    id: 'compound',
    displayName: 'Compound',
    chains: ['ethereum', 'arbitrum', 'base', 'polygon'],
    launchDate: '2018-09-27',
    auditStatus: 'top-firm',
    auditFirms: ['Trail of Bits', 'OpenZeppelin'],
    website: 'https://compound.finance',
    defillamaSlug: 'compound-v3',
    description: 'Autonomous interest rate protocol on Ethereum.',
  },

  uniswap: {
    id: 'uniswap',
    displayName: 'Uniswap',
    chains: ['ethereum', 'polygon', 'arbitrum', 'base', 'avalanche', 'bnb'],
    launchDate: '2018-11-02',
    auditStatus: 'top-firm',
    auditFirms: ['Trail of Bits', 'ABDK'],
    website: 'https://uniswap.org',
    defillamaSlug: 'uniswap-v3',
    description: 'Automated market maker and decentralized exchange.',
  },

  pancakeswap: {
    id: 'pancakeswap',
    displayName: 'PancakeSwap',
    chains: ['bnb', 'ethereum', 'base', 'arbitrum'],
    launchDate: '2020-09-20',
    auditStatus: 'known-firm',
    auditFirms: ['CertiK', 'PeckShield'],
    website: 'https://pancakeswap.finance',
    defillamaSlug: 'pancakeswap',
    description: 'Leading DEX and yield farm on BNB Chain.',
  },

  curve: {
    id: 'curve',
    displayName: 'Curve Finance',
    chains: ['ethereum', 'polygon', 'arbitrum', 'avalanche', 'base'],
    launchDate: '2020-01-22',
    auditStatus: 'known-firm',
    auditFirms: ['Trail of Bits', 'QuantStamp'],
    website: 'https://curve.fi',
    defillamaSlug: 'curve',
    description: 'Stablecoin and pegged-asset AMM with low slippage.',
  },

  gmx: {
    id: 'gmx',
    displayName: 'GMX',
    chains: ['arbitrum', 'avalanche'],
    launchDate: '2021-09-01',
    auditStatus: 'known-firm',
    auditFirms: ['ABDK', 'Code4rena'],
    website: 'https://gmx.io',
    defillamaSlug: 'gmx',
    description: 'Decentralized perpetual exchange with on-chain liquidity.',
  },

  'trader-joe': {
    id: 'trader-joe',
    displayName: 'Trader Joe',
    chains: ['avalanche', 'arbitrum', 'bnb'],
    launchDate: '2021-07-01',
    auditStatus: 'known-firm',
    auditFirms: ['Hacken', 'PeckShield'],
    website: 'https://traderjoexyz.com',
    defillamaSlug: 'trader-joe',
    description: 'DEX with liquidity book AMM on Avalanche.',
  },

  'benqi-lending': {
    id: 'benqi-lending',
    displayName: 'BENQI Lending',
    chains: ['avalanche'],
    launchDate: '2021-08-19',
    auditStatus: 'known-firm',
    auditFirms: ['Halborn', 'Hacken'],
    website: 'https://benqi.fi',
    defillamaSlug: 'benqi',
    description: 'Liquidity market protocol on Avalanche.',
  },

  'rocket-pool': {
    id: 'rocket-pool',
    displayName: 'Rocket Pool',
    chains: ['ethereum'],
    launchDate: '2021-11-09',
    auditStatus: 'top-firm',
    auditFirms: ['Trail of Bits', 'Sigma Prime', 'Consensys Diligence'],
    website: 'https://rocketpool.net',
    defillamaSlug: 'rocket-pool',
    description: 'Decentralized Ethereum liquid staking protocol.',
  },

  'lido-finance': {
    id: 'lido-finance',
    displayName: 'Lido Finance',
    chains: ['ethereum', 'polygon'],
    launchDate: '2020-12-17',
    auditStatus: 'top-firm',
    auditFirms: ['Sigma Prime', 'Quantstamp', 'MixBytes'],
    website: 'https://lido.fi',
    defillamaSlug: 'lido',
    description: 'Liquid staking for ETH and other PoS assets.',
  },

  radiant: {
    id: 'radiant',
    displayName: 'Radiant Capital',
    chains: ['arbitrum', 'bnb', 'ethereum'],
    launchDate: '2022-07-25',
    auditStatus: 'known-firm',
    auditFirms: ['PeckShield', 'Zokyo'],
    website: 'https://radiant.capital',
    defillamaSlug: 'radiant-capital',
    description: 'Cross-chain money market on LayerZero.',
  },

  blend: {
    id: 'blend',
    displayName: 'Blend (Stellar)',
    chains: ['stellar'],
    launchDate: '2023-06-15',
    auditStatus: 'known-firm',
    auditFirms: ['OtterSec'],
    website: 'https://blend.capital',
    defillamaSlug: 'blend-stellar',
    description: 'Permissionless lending protocol on Stellar.',
  },

  orca: {
    id: 'orca',
    displayName: 'Orca',
    chains: ['solana'],
    launchDate: '2021-02-20',
    auditStatus: 'known-firm',
    auditFirms: ['Kudelski', 'Neodyme'],
    website: 'https://www.orca.so',
    defillamaSlug: 'orca',
    description: 'Concentrated liquidity AMM on Solana.',
  },

  marinade: {
    id: 'marinade',
    displayName: 'Marinade Finance',
    chains: ['solana'],
    launchDate: '2021-08-01',
    auditStatus: 'known-firm',
    auditFirms: ['Neodyme', 'Kudelski'],
    website: 'https://marinade.finance',
    defillamaSlug: 'marinade-finance',
    description: 'Liquid staking protocol on Solana.',
  },

  pendle: {
    id: 'pendle',
    displayName: 'Pendle Finance',
    chains: ['ethereum', 'arbitrum', 'bnb', 'avalanche'],
    launchDate: '2021-06-28',
    auditStatus: 'known-firm',
    auditFirms: ['Ackee Blockchain', 'Dedaub'],
    website: 'https://pendle.finance',
    defillamaSlug: 'pendle',
    description: 'Yield tokenization and trading protocol.',
  },
};

export default PROTOCOLS;

/** Look up protocol metadata by ID */
export function getProtocolMeta(id: string): ProtocolMeta | undefined {
  return PROTOCOLS[id];
}
