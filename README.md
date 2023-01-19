# Firn Protocol's Snap

Firn's Snap allows websites to securely invoke Firn protocol on behalf of users. An end-to-end, working example
exhibiting the below methods is available at [`firnprotocol/example`](https://github.com/firnprotocol/example)
.

## API

### Connecting

Connect to the Firn Snap
in [the standard way](https://docs.metamask.io/guide/snaps-development-guide.html#the-snap-source-code); that is:

```javascript
await window.ethereum.request({
  method: "wallet_enable",
  params: [{ wallet_snap: { "npm:@firnprotocol/snap": {} } }],
});
```

### Initialize

The `initialize` method prompts the user to "log into" their Firn account (in practice, this entails signing a special
message). As a side effect, it caches the user's secret Firn key in secure, encrypted storage (visible only to the Firn
snap, and not to the calling website).

In practice, you may want to call this method immediately after connecting to the Snap in the first place. All of the below methods require that this method be executed first.

```javascript
await window.ethereum.request({
  method: "wallet_invokeSnap",
  params: ["npm:@firnprotocol/snap", {
    method: "initialize",
  }],
});
```

This method will either return nothing (upon success) or will throw an error (upon a failure).

### Request Balance

The `requestBalance` method prompts the user to disclose their Firn balance. The RPC method will _either_ return the
user's Firn balance—denominated in _milliether_ (!)—as a plain JavaScript number, or will throw an error. Here's an example
invocation:

```javascript
const balance = await window.ethereum.request({
  method: "wallet_invokeSnap",
  params: ["npm:@firnprotocol/snap", {
    method: "requestBalance",
  }],
});
console.log(`User's Firn balance is ${(balance / 1000).toFixed(3)} ETH.`);
```

### Transact

The `transact` method prompts the user to anonymously execute a prescribed `unsignedTx` anonymously, on behalf of his
Firn account. It will either return the `transactionReceipt` of the resulting successful, _mined_ transaction, or else will throw
an error. Here's an example invocation:

```javascript
const provider = new ethers.providers.Web3Provider(window.ethereum);
const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);
const unsignedTx = await contract.populateTransaction.myMethod(
  {
    firstArg: aValue,
    secondArg: anotherValue,
  }, {
    value: ethers.utils.parseUnits("1", "ether"),
  }
);
const transactionReceipt = await window.ethereum.request({
  method: "wallet_invokeSnap",
  params: ["npm:@firnprotocol/snap", {
    method: "transact",
    params: unsignedTx,
  }],
});
console.log(`Transaction successful; its hash is ${transactionReceipt.transactionHash}.`);
```
