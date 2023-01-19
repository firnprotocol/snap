export const CHAIN_ID = {
  ETHEREUM: 1,
  OPTIMISM: 10,
  ARBITRUM: 42161,
};

export const CHAIN_PARAMS = {
  [CHAIN_ID.ETHEREUM]: {
    message: "Log into your Firn account on mainnet Ethereum.",
  },
  [CHAIN_ID.OPTIMISM]: {
    message: "This message will log you into your Firn account.", // inconsistent...!
  },
  [CHAIN_ID.ARBITRUM]: {
    message: "Log into your Firn account on Arbitrum One.",
  },
};
