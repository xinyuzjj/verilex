import { expect } from "chai";
import { ethers } from "hardhat";

describe("FeedConsumer (Chainlink Data Feeds pattern)", function () {
  async function deploy(price = 74_000_000, staleness = 3600) {
    // SGD/USD style feed: 8 decimals, 0.74 USD per SGD.
    const mock = await ethers.deployContract("MockV3Aggregator", [8, price]);
    const consumer = await ethers.deployContract("FeedConsumer", [await mock.getAddress(), staleness]);
    return { mock, consumer };
  }

  it("reads the latest price and converts amounts", async function () {
    const { consumer } = await deploy();
    const [price] = await consumer.latestPrice();
    expect(price).to.equal(74_000_000);
    // 1,350,000 SGD * 0.74 = 999,000 USD
    expect(await consumer.convert(1_350_000)).to.equal(999_000);
  });

  it("tracks feed updates", async function () {
    const { mock, consumer } = await deploy();
    await mock.updateAnswer(75_000_000);
    const [price] = await consumer.latestPrice();
    expect(price).to.equal(75_000_000);
  });

  it("rejects a stale price", async function () {
    const { consumer } = await deploy(74_000_000, 10);
    await ethers.provider.send("evm_increaseTime", [60]);
    await ethers.provider.send("evm_mine", []);
    await expect(consumer.latestPrice()).to.be.revertedWith("stale price");
  });

  it("rejects a non-positive price", async function () {
    const { mock, consumer } = await deploy();
    await mock.updateAnswer(0);
    await expect(consumer.latestPrice()).to.be.revertedWith("non-positive price");
  });
});
