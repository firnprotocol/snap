import { arbitrum, mainnet, optimism, base } from "viem/chains";

export const CHAIN_ID = {
  "0x1": "Ethereum",
  "0xa": "OP Mainnet",
  "0xa4b1": "Arbitrum One",
  "0x2105": "Base"
};

export const CHAIN_PARAMS = {
  "Ethereum": {
    chain: mainnet,
  },
  "OP Mainnet": {
    chain: optimism,
  },
  "Arbitrum One": {
    chain: arbitrum,
  },
  "Base": {
    chain: base,
  }
};
