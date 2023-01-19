const EPOCH_LENGTH = 60;

export async function nextEpoch(provider, block) {
  const epoch = Math.floor(block.timestamp / EPOCH_LENGTH);
  return new Promise((resolve) => {
    const listener = async (blockNumber) => {
      const block = await provider.getBlock(blockNumber); // would prob be equivalent to do "latest"?
      if (Math.floor(block.timestamp / EPOCH_LENGTH) > epoch) {
        provider.off("block", listener);
        resolve(block);
      }
    };
    provider.on("block", listener);
  });
}
