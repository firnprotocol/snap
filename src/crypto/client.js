import * as mcl from "mcl-wasm";
import { ethers } from "ethers";

import { BN128 } from "./bn128";
import {
  ElGamal,
  ElGamalVector,
  N,
  PointVector,
} from "./algebra";
import { WithdrawalProof } from "./withdrawal";
import { nextEpoch } from "../utils/nextEpoch"

export const EPOCH_LENGTH = 60;

class State {
  constructor() { // should i be using BNs?
    this.available = 0;
    this.pending = 0;
  }

  rollOver() { // is epoch necessary? will be called async.
    this.available += this.pending;
    this.pending = 0;
  }
}

export class Client {
  constructor({ secret, firnContract, readerContract }) {
    this.secret = secret;
    this.pub = BN128.toCompressed(mcl.mul(BN128.BASE, this.secret)); // we already computed this elsewhere, but...
    this.state = new State();
    this.firnContract = firnContract;
    this.readerContract = readerContract;
  }

  async initialize(provider) { // params won't be retained.
    const block = await provider.getBlock("latest");
    const epoch = Math.floor(block.timestamp / EPOCH_LENGTH);
    // use "advanced poller" in the below? could, but this could start proliferating throughout the entire project.
    const [present, future] = await Promise.all([
      this.firnContract.simulateAccounts([this.pub], epoch).then((result) => ElGamal.deserialize(result[0])),
      this.firnContract.simulateAccounts([this.pub], epoch + 1).then((result) => ElGamal.deserialize(result[0])),
      // extreme subtleties around the timing here, and our clock vs. theirs. i guess i'll just trust it at this point.
      // the analysis is pretty damn subtle when the clocks don't match. basically have to assume they do for now.
    ]);
    // all hell will break loose in the below if you have a negative pending; i.e., sent something within same epoch.
    this.state.available += this.readBalance(present);
    this.state.pending += this.readBalance(future.sub(present));
    nextEpoch(provider, block).then((block) => {
      this.state.rollOver();
    });
  }

  readBalance(account) {
    const exponent = ElGamal.decrypt(account, this.secret);
    let accumulator = new mcl.G1();
    for (let i = 0; i < Math.pow(2, 32); i++) {
      if (accumulator.isEqual(exponent)) return i;
      accumulator = mcl.add(accumulator, BN128.BASE);
    }
    // just do brute force, since worker seems very hard to do. not clear that we were ever gaining much through the workers, actually.
  }

  async withdraw(amount, epoch, fee, destination, data) {
    const anonset = await this.readerContract.sampleAnonset(ethers.utils.hexlify(ethers.utils.randomBytes(32)), amount).then((result) => result.slice());
    const random = ethers.utils.randomBytes(N); // below only reads from {1, ..., N - 1}
    for (let i = N - 1; i > 0; i--) {
      const j = random[i] % (i + 1);
      const swap = anonset[j];
      anonset[j] = anonset[i];
      anonset[i] = swap;
    }
    let index = undefined;
    for (let i = 0; i < N; i++) { // am i or the recipient already in the anonset?
      if (anonset[i] === this.pub) index = i;
    }
    if (index === undefined) {
      index = random[0] & N - 1;
      anonset[index] = this.pub; // is this secure?
    }
    const accounts = await this.firnContract.simulateAccounts(anonset, epoch);
    const Y = new PointVector(anonset.map(BN128.fromCompressed));
    const r = BN128.randomScalar();
    const D = mcl.mul(BN128.BASE, r);
    const C = new ElGamalVector(Y.vector.map((pub, i) => {
      let message = new mcl.G1();
      if (i === index) {
        const exponent = new mcl.Fr();
        exponent.setInt(-amount - fee);
        message = mcl.mul(ElGamal.base.g, exponent);
      }
      return new ElGamal(mcl.add(message, mcl.mul(pub, r)), D); // wastes a curve addition
    }));
    const Cn = new ElGamalVector(accounts.map((account, i) => ElGamal.deserialize(account).add(C.vector[i])));
    const u = mcl.mul(BN128.gEpoch(epoch), this.secret);
    const proof = WithdrawalProof.prove(
      Y,
      Cn,
      C,
      epoch,
      this.secret,
      r,
      amount,
      this.state.available - amount - fee,
      index,
      fee,
      destination,
      data,
    );
    return [
      Y.vector.map(BN128.toCompressed),
      C.vector.map((ciphertext) => BN128.toCompressed(ciphertext.left)),
      BN128.toCompressed(D),
      BN128.toCompressed(u),
      proof.serialize(),
    ];
  }
}
