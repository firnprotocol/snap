import { EPOCH_LENGTH } from "../crypto/client";

export function nextEpoch(publicClient, block) {
  const epoch = Math.floor(Number(block.timestamp) / EPOCH_LENGTH);
  return new Promise((resolve) => {
    const unwatch = publicClient.watchBlocks({
      onBlock: (block) => {
        if (Math.floor(Number(block.timestamp) / EPOCH_LENGTH) > epoch) {
          unwatch();
          resolve(block);
        }
      },
    });
  });
}
