import { arbitrum, base,mainnet, optimism } from "viem/chains";

export const CHAINS = {
  [mainnet.id]: "Ethereum",
  [optimism.id]: "OP Mainnet",
  [arbitrum.id]: "Arbitrum One",
  [base.id]: "Base",
};

export const CHAIN_PARAMS = {
  Ethereum: {
    chain: mainnet,
  },
  "OP Mainnet": {
    chain: optimism,
  },
  "Arbitrum One": {
    chain: arbitrum,
  },
  Base: {
    chain: base,
  },
};
